import { and, eq, isNull, or } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  type AudioFeatures,
  appConfig,
  bucket,
  bucketMember,
  type FeatureStats,
  type NewBucket,
  rating,
  track,
} from "@/db/schema";
import { addFeatureSample, emptyFeatureStats, updateCentroid } from "@/lib/bucketing/centroid";
import { buildEmbedding, derivePrimaryGenre } from "@/lib/embedding";
import { ensureActiveModelVersionInTx } from "@/lib/ranking/version";
import { TASTE_EXPORT_SCHEMA, type TasteExport, type TasteTrackRef } from "./schema";

/**
 * Import a `TasteExport` into a (typically empty) install. Round-trip target:
 * `export → wipe DB → import` reproduces buckets and ratings well enough for
 * the user's taste model to keep working. Verification step #10 in the plan.
 *
 * Strategy:
 *
 *   1. Validate via Zod (`TASTE_EXPORT_SCHEMA`). Reject malformed payloads at
 *      the boundary; the rest of the import assumes a typed shape.
 *   2. In a single transaction, for each unique track reference:
 *        a. Try ISRC, then spotify_id, then exact (artist, title) match.
 *        b. Insert a fresh `track` row when no match — embedding derived from
 *           genres (audio features unavailable; cosine still works).
 *      Track inserts here intentionally bypass `resolveCandidate` because
 *      that path also writes a `track_source` row, and the export carries no
 *      source attribution.
 *   3. For each bucket: insert the bucket row with a zero-seed centroid +
 *      empty feature_stats, then walk members in export order Welford-folding
 *      audio (when present) and the embedding into the centroid. Members are
 *      inserted into `bucket_member` with `similarityAtJoin = 1` (no original
 *      similarity to recover) — the radar viz still works since centroid +
 *      feature_stats are correct.
 *   4. For each rating: ensure an active broad version exists (idempotent
 *      bootstrap), then insert with `surfaceEventId = null` — Constraint #3's
 *      cold-start path. Original `ratedAt` preserved so timeline plots stay
 *      aligned.
 *   5. Optionally clobber `app_config` knobs from the export's `config`
 *      block. Active version pointers are NOT re-imported — they're tied to
 *      this install's model_version chain.
 *
 * Idempotency: re-importing the same export adds no duplicate buckets but DOES
 * re-add ratings (each rating row is unique by id). Callers that want a clean
 * slate should wipe before importing.
 */

export type TasteImportResult = {
  trackInserted: number;
  trackMatched: number;
  bucketsCreated: number;
  membersAdded: number;
  ratingsInserted: number;
};

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function importTaste(db: Database, raw: unknown): Promise<TasteImportResult> {
  const data: TasteExport = TASTE_EXPORT_SCHEMA.parse(raw);

  return db.transaction(async (tx) => {
    const counts = {
      trackInserted: 0,
      trackMatched: 0,
      bucketsCreated: 0,
      membersAdded: 0,
      ratingsInserted: 0,
    };

    if (data.config) {
      await tx
        .insert(appConfig)
        .values({ id: 1, ...data.config })
        .onConflictDoUpdate({ target: appConfig.id, set: data.config });
    }

    // Track resolution cache. Keyed by the export's ref shape so a track that
    // appears as a bucket member AND as a rating round-trips to the same row.
    const trackCache = new Map<string, number>();

    const resolveTrack = async (ref: TasteTrackRef): Promise<number> => {
      const key = trackKey(ref);
      const cached = trackCache.get(key);
      if (cached !== undefined) return cached;
      const result = await resolveOrInsertTrack(tx, ref);
      trackCache.set(key, result.id);
      if (result.created) counts.trackInserted += 1;
      else counts.trackMatched += 1;
      return result.id;
    };

    // LAB-61 — keep-inference fallback for pre-LAB-61 exports whose members
    // carry no origin, mirroring the FULL 0010 backfill mapping: a member
    // whose track was kept in this same export imports as 'discovery_keep';
    // a member whose track was rated but never kept is legacy eager-join
    // cruft and is SKIPPED (0010 deletes those membership rows — importing
    // them as seeds would re-anchor refill on a disliked track); a member
    // with no rating at all imports as the generic 'seed_track'. Ratings
    // themselves always import (the eval substrate keeps every decision).
    const keptTrackKeys = new Set(
      data.ratings.filter((r) => r.decision === "keep").map((r) => trackKey(r.track)),
    );
    const ratedTrackKeys = new Set(data.ratings.map((r) => trackKey(r.track)));

    for (const exportedBucket of data.buckets) {
      const seedCentroid = Array.from({ length: 64 }, () => 0);
      const seed: NewBucket = {
        name: exportedBucket.name,
        color: exportedBucket.color,
        centroid: seedCentroid,
        featureStats: emptyFeatureStats(),
        memberCount: 0,
        primaryGenre: exportedBucket.primaryGenre,
        isColdStartSeed: exportedBucket.isColdStartSeed,
      };
      const [row] = await tx.insert(bucket).values(seed).returning({ id: bucket.id });
      if (!row) throw new Error("importTaste: bucket insert returned no rows");
      counts.bucketsCreated += 1;

      let centroid: number[] = seedCentroid;
      let stats: FeatureStats = emptyFeatureStats();
      let memberCount = 0;
      for (const memberRef of exportedBucket.members) {
        let origin = memberRef.origin;
        if (!origin) {
          const key = trackKey(memberRef);
          if (keptTrackKeys.has(key)) origin = "discovery_keep";
          else if (ratedTrackKeys.has(key))
            continue; // rated-but-never-kept: 0010 delete arm
          else origin = "seed_track";
        }
        const trackId = await resolveTrack(memberRef);
        const [t] = await tx.select().from(track).where(eq(track.id, trackId)).limit(1);
        if (!t) continue;
        const memberEmbedding =
          t.embedding ?? buildEmbedding({ audioFeatures: t.audioFeatures, genres: t.genres });
        // The bucket_member.track_id unique index forbids a track from
        // belonging to two buckets. If an export includes the same track in
        // multiple buckets (corrupted file or cross-install merge), we keep
        // the first assignment and skip subsequent ones rather than failing
        // the whole import. Only fold the track into centroid/stats/memberCount
        // *after* the insert succeeds, otherwise a skipped row would leave a
        // phantom member counted in the bucket's stats.
        try {
          await tx
            .insert(bucketMember)
            .values({ bucketId: row.id, trackId, similarityAtJoin: 1, origin });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          continue;
        }
        centroid = updateCentroid(centroid, memberCount, memberEmbedding);
        if (t.audioFeatures) stats = addFeatureSample(stats, t.audioFeatures);
        memberCount += 1;
        counts.membersAdded += 1;
      }
      await tx
        .update(bucket)
        .set({ centroid, featureStats: stats, memberCount })
        .where(eq(bucket.id, row.id));
    }

    if (data.ratings.length > 0) {
      const broadVersion = await ensureActiveModelVersionInTx(tx, "broad");
      for (const r of data.ratings) {
        const trackId = await resolveTrack(r.track);
        await tx.insert(rating).values({
          trackId,
          decision: r.decision,
          modelVersionId: broadVersion.id,
          surfaceEventId: null,
          ratedAt: new Date(r.ratedAt),
        });
        counts.ratingsInserted += 1;
      }
    }

    return counts;
  });
}

function trackKey(ref: TasteTrackRef): string {
  return [
    ref.isrc ?? "",
    ref.spotifyId ?? "",
    ref.title.toLowerCase(),
    ref.artist.toLowerCase(),
  ].join("|");
}

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION;
}

async function resolveOrInsertTrack(
  tx: Tx,
  ref: TasteTrackRef,
): Promise<{ id: number; created: boolean }> {
  if (ref.isrc) {
    const [hit] = await tx
      .select({ id: track.id })
      .from(track)
      .where(eq(track.isrc, ref.isrc))
      .limit(1);
    if (hit) return { id: hit.id, created: false };
  }
  if (ref.spotifyId) {
    const [hit] = await tx
      .select({ id: track.id })
      .from(track)
      .where(eq(track.spotifyId, ref.spotifyId))
      .limit(1);
    if (hit) return { id: hit.id, created: false };
  }
  // Fallback: exact (artist, title) match scoped to rows that don't conflict
  // on the strong identifiers — same guard as the enrichment resolver.
  const isrcGuard = ref.isrc ? or(isNull(track.isrc), eq(track.isrc, ref.isrc)) : undefined;
  const spotifyGuard = ref.spotifyId
    ? or(isNull(track.spotifyId), eq(track.spotifyId, ref.spotifyId))
    : undefined;
  const [hit] = await tx
    .select({ id: track.id })
    .from(track)
    .where(and(eq(track.artist, ref.artist), eq(track.title, ref.title), isrcGuard, spotifyGuard))
    .limit(1);
  if (hit) return { id: hit.id, created: false };

  const primaryGenre = derivePrimaryGenre(ref.genres);
  const embedding = buildEmbedding({ audioFeatures: null, genres: ref.genres });
  const [row] = await tx
    .insert(track)
    .values({
      isrc: ref.isrc,
      spotifyId: ref.spotifyId,
      title: ref.title,
      artist: ref.artist,
      album: ref.album ?? null,
      genres: ref.genres,
      primaryGenre,
      embedding,
    })
    .returning({ id: track.id });
  if (!row) throw new Error("importTaste: track insert returned no rows");
  return { id: row.id, created: true };
}

// Audio features type re-export so the trpc layer + tests can import a single
// barrel without reaching into `db/schema`.
export type { AudioFeatures };
