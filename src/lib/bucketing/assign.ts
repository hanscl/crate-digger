import { eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  type AudioFeatures,
  appConfig,
  bucket,
  bucketMember,
  type FeatureStats,
  track,
} from "@/db/schema";
import { buildEmbedding, cosine, derivePrimaryGenre } from "@/lib/embedding";
import { addFeatureSample, emptyFeatureStats, updateCentroid } from "./centroid";

/**
 * Outcome of a single bucket assignment. `spawned=true` means a brand-new
 * bucket was created with this track as its sole seed; `false` means the
 * track joined an existing bucket and the centroid was updated. The caller
 * uses the `alreadyAssigned` flag to short-circuit retries.
 */
export type AssignResult = {
  trackId: number;
  bucketId: number;
  similarity: number;
  spawned: boolean;
  alreadyAssigned: boolean;
  primaryGenre: string | null;
  /** Distinct from spawned — includes neutral-audio fallbacks; used for telemetry. */
  hadAudioFeatures: boolean;
};

export type AssignOptions = {
  /** Cosine threshold above which a track joins the nearest bucket. Falls back to app_config. */
  spawnThreshold?: number;
  /** Mark a freshly-spawned bucket as a cold-start seed (Setup-screen playlist flow). */
  coldStartSeed?: boolean;
};

const FALLBACK_SPAWN_THRESHOLD = 0.7;

async function loadSpawnThreshold(db: Database): Promise<number> {
  const [row] = await db
    .select({ spawnThreshold: appConfig.spawnThreshold })
    .from(appConfig)
    .limit(1);
  return row?.spawnThreshold ?? FALLBACK_SPAWN_THRESHOLD;
}

function defaultBucketName(primaryGenre: string | null): string {
  // Placeholder; the Mastra `bucket-namer` agent in Phase 6 replaces this on spawn.
  return primaryGenre ? `${primaryGenre} (auto)` : "Unnamed (auto)";
}

/**
 * Hybrid spawn-or-join assignment. The contract pinned by tests:
 *
 *   1. Only buckets that share the track's primary genre are considered.
 *      A track whose primary genre matches no existing bucket spawns a new
 *      one regardless of how close it is to other centroids.
 *   2. Among same-genre buckets, the closest centroid wins. If max cosine
 *      similarity ≥ `spawnThreshold` the track joins; otherwise it spawns.
 *   3. Joining incrementally updates the bucket's centroid, feature_stats
 *      (Welford), and member_count in a single transaction with the
 *      bucket_member insert. Re-running on the same track is a no-op.
 *
 * Soft-fail: tracks with neither audio features nor genres still get
 * embedded (audio dims default to 0.5, genre dims to zero) and assigned —
 * they end up in an "Unnamed" bucket together until enrichment fills in.
 */
export async function assignTrack(
  db: Database,
  trackId: number,
  options: AssignOptions = {},
): Promise<AssignResult> {
  const [t] = await db.select().from(track).where(eq(track.id, trackId)).limit(1);
  if (!t) throw new Error(`assignTrack: track id=${trackId} not found`);

  // Idempotency: if this track is already a member of any bucket, return that.
  const [existing] = await db
    .select({ bucketId: bucketMember.bucketId, similarity: bucketMember.similarityAtJoin })
    .from(bucketMember)
    .where(eq(bucketMember.trackId, trackId))
    .limit(1);
  if (existing) {
    return {
      trackId,
      bucketId: existing.bucketId,
      similarity: existing.similarity ?? 0,
      spawned: false,
      alreadyAssigned: true,
      primaryGenre: t.primaryGenre,
      hadAudioFeatures: t.audioFeatures !== null,
    };
  }

  // Ensure embedding + primary genre are persisted on the track row. Other
  // phases (ranking, surfacing) read these directly from `track`.
  const primaryGenre = t.primaryGenre ?? derivePrimaryGenre(t.genres);
  const embedding =
    t.embedding ?? buildEmbedding({ audioFeatures: t.audioFeatures, genres: t.genres });
  if (!t.embedding || t.primaryGenre !== primaryGenre) {
    await db
      .update(track)
      .set({ embedding, primaryGenre, updatedAt: sql`NOW()` })
      .where(eq(track.id, trackId));
  }

  const candidates = await db
    .select()
    .from(bucket)
    .where(primaryGenre ? eq(bucket.primaryGenre, primaryGenre) : isNull(bucket.primaryGenre));

  let best: { bucket: (typeof candidates)[number]; sim: number } | null = null;
  for (const b of candidates) {
    const sim = cosine(embedding, b.centroid);
    if (!best || sim > best.sim) best = { bucket: b, sim };
  }

  const threshold = options.spawnThreshold ?? (await loadSpawnThreshold(db));
  const hadAudioFeatures = t.audioFeatures !== null;

  if (best && best.sim >= threshold) {
    return joinBucket(db, t.id, t.audioFeatures, embedding, best.bucket, best.sim, {
      primaryGenre,
      hadAudioFeatures,
    });
  }
  return spawnBucket(db, t.id, t.audioFeatures, embedding, primaryGenre, {
    coldStartSeed: options.coldStartSeed ?? false,
    hadAudioFeatures,
  });
}

async function joinBucket(
  db: Database,
  trackId: number,
  audio: AudioFeatures | null,
  embedding: number[],
  target: { id: number; centroid: number[]; memberCount: number; featureStats: FeatureStats },
  similarity: number,
  ctx: { primaryGenre: string | null; hadAudioFeatures: boolean },
): Promise<AssignResult> {
  const newCentroid = updateCentroid(target.centroid, target.memberCount, embedding);
  const newFeatureStats = audio
    ? addFeatureSample(target.featureStats, audio)
    : target.featureStats;

  return db.transaction(async (tx) => {
    await tx
      .update(bucket)
      .set({
        centroid: newCentroid,
        featureStats: newFeatureStats,
        memberCount: target.memberCount + 1,
        updatedAt: sql`NOW()`,
      })
      .where(eq(bucket.id, target.id));

    await tx
      .insert(bucketMember)
      .values({ bucketId: target.id, trackId, similarityAtJoin: similarity })
      .onConflictDoNothing({ target: [bucketMember.bucketId, bucketMember.trackId] });

    return {
      trackId,
      bucketId: target.id,
      similarity,
      spawned: false,
      alreadyAssigned: false,
      primaryGenre: ctx.primaryGenre,
      hadAudioFeatures: ctx.hadAudioFeatures,
    };
  });
}

async function spawnBucket(
  db: Database,
  trackId: number,
  audio: AudioFeatures | null,
  embedding: number[],
  primaryGenre: string | null,
  ctx: { coldStartSeed: boolean; hadAudioFeatures: boolean },
): Promise<AssignResult> {
  const seedStats = audio ? addFeatureSample(emptyFeatureStats(), audio) : emptyFeatureStats();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(bucket)
      .values({
        name: defaultBucketName(primaryGenre),
        centroid: embedding,
        featureStats: seedStats,
        memberCount: 1,
        primaryGenre,
        isColdStartSeed: ctx.coldStartSeed,
      })
      .returning({ id: bucket.id });
    if (!row) throw new Error("bucket insert returned no rows");

    await tx
      .insert(bucketMember)
      .values({ bucketId: row.id, trackId, similarityAtJoin: 1.0 })
      .onConflictDoNothing({ target: [bucketMember.bucketId, bucketMember.trackId] });

    return {
      trackId,
      bucketId: row.id,
      similarity: 1.0,
      spawned: true,
      alreadyAssigned: false,
      primaryGenre,
      hadAudioFeatures: ctx.hadAudioFeatures,
    };
  });
}
