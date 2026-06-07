import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, bucket, bucketMember, track } from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { evaluateBucketRecommendations } from "@/lib/bucketing/recommendations";
import { cosine } from "@/lib/embedding";
import { enrichGenresFromDiscogs } from "@/lib/enrichment/discogs";
import { selectBucketSeeds } from "@/lib/ingestion/exemplar";
import { resolveCandidate, resolveSpotifyId } from "@/lib/enrichment/resolve";
import { enrichGenresFromLastfm } from "@/lib/enrichment/lastfm-tags";
import { enrichGenresFromMusicBrainz } from "@/lib/enrichment/musicbrainz";
import { enrichAudioFeaturesForTracks } from "@/lib/enrichment/reccobeats";
import { retrainBroad } from "@/lib/feedback/retrain";
import {
  type RawCandidate,
  type SourceAdapter,
  type SourceId,
  createDefaultRegistry,
} from "@/lib/ingestion";
import type { Candidate } from "@/lib/ranking/types";
import { runSurfacingBatch } from "@/lib/surfacing/pipeline";
import type { Env } from "@/server/env";
import { type BucketNamerInput, type GenreCount, nameBucket } from "@/mastra/agents/bucket-namer";

/**
 * Pure(-ish) step bodies for the daily pipeline workflow. Kept out of the
 * Mastra `createStep` wrapper so they can be unit-tested directly with a
 * `Database` and `Env` — Mastra orchestration is just glue around these.
 *
 * Every step returns a structured summary the workflow accumulator threads
 * forward; nothing here writes to the accumulator itself.
 */

export type PullEnrichSummary = {
  pulledCount: number;
  perSource: { source: SourceId; pulled: number }[];
  resolvedTrackIds: number[];
  newlyCreatedTrackIds: number[];
  /** Candidates whose `spotifyId` was stamped by the ingest-time search pass (LAB-46). */
  spotifyResolvedCount: number;
  audioFeaturesUpdated: number;
  genresUpdated: number;
  mbGenresUpdated: number;
  discogsGenresUpdated: number;
  /** Candidates pulled by the taste-seeded Last.fm `getSimilar` pass (LAB-39). */
  similarPulledCount: number;
};

const DEFAULT_PER_SOURCE_LIMIT = 25;
/** Top-N buckets seeded for the Last.fm similar pull (LAB-39). */
const SIMILAR_SEED_BUCKETS = 5;

/**
 * Step 1: pull `mode: "trending"` from every available adapter, resolve each
 * candidate to a `track` row, then enrich. Enrichment runs in fixed order:
 *
 *   ReccoBeats (audio) → Last.fm → MusicBrainz → Discogs
 *
 * The genre layers (Last.fm, MB, Discogs) merge tags additively into
 * `track.genres` and rebuild `track.embedding` from the post-ReccoBeats
 * audio features at each step. Last.fm runs first because it's the
 * cheapest (per-artist cache); MB second so it can reuse `track.mbid` if
 * Last.fm's `track.getInfo` populated it; Discogs last because it's the
 * slowest (1200ms-paced, 2–3 calls per track). Each is gated on its own
 * credentials and degrades silently when absent.
 *
 * Adapter failures degrade silently (constraint #1) — `pullCandidates`
 * already returns `[]` rather than throwing.
 *
 * LAB-39 — taste-seeded similar pull: after the generic trending sweep, if a
 * Last.fm adapter is present we pick a centroid-nearest exemplar from each of
 * the top-N buckets (by member count) and call Last.fm `track.getSimilar`
 * seeded on it. Those candidates merge into the SAME pool — deduped, resolved,
 * and enriched identically — so refill draws from taste-relevant tracks rather
 * than only generic trending. Per-seed pulls are issued sequentially to
 * respect Last.fm's rate limits. Last.fm-only first cut; the pass is a strict
 * no-op when no `lastfm` adapter is available.
 */
export async function pullAndEnrichTrending(
  db: Database,
  env: Env,
  options: {
    limitPerSource?: number;
    adapters?: readonly SourceAdapter[];
    similarSeedBuckets?: number;
  } = {},
): Promise<PullEnrichSummary> {
  const limit = options.limitPerSource ?? DEFAULT_PER_SOURCE_LIMIT;
  const adapters = options.adapters ?? createDefaultRegistry().available(env);

  const perSource: { source: SourceId; pulled: number }[] = [];
  const resolvedIds = new Set<number>();
  const newlyCreatedIds: number[] = [];
  let pulledCount = 0;
  let spotifyResolvedCount = 0;

  // Per-candidate body, extracted so the spotify-id pre-resolution + resolution
  // is a single reusable unit. LAB-39 stacks similar-seeded candidates onto this
  // same loop and can reuse this closure verbatim.
  const resolveInto = async (c: RawCandidate): Promise<void> => {
    const resolved = await resolveSpotifyId(c, env);
    if (resolved.spotifyId !== c.spotifyId) spotifyResolvedCount += 1;
    const r = await resolveCandidate(db, resolved);
    resolvedIds.add(r.trackId);
    if (r.created) newlyCreatedIds.push(r.trackId);
  };

  for (const adapter of adapters) {
    const candidates = await adapter.pullCandidates({ mode: "trending", limit }, env);
    perSource.push({ source: adapter.id, pulled: candidates.length });
    pulledCount += candidates.length;
    for (const c of candidates) {
      await resolveInto(c);
    }
  }

  // LAB-39 — taste-seeded similar pull. Strict no-op unless a Last.fm adapter
  // is available (Last.fm-only first cut). Seeds are the centroid-nearest
  // exemplar of each top-N bucket; per-seed `getSimilar` calls are issued
  // sequentially to respect Last.fm rate limits — NEVER Promise.all.
  let similarPulled = 0;
  const lastfm = adapters.find((a) => a.id === "lastfm");
  if (lastfm) {
    const seeds = await selectBucketSeeds(db, {
      maxBuckets: options.similarSeedBuckets ?? SIMILAR_SEED_BUCKETS,
    });
    for (const seed of seeds) {
      const cands = await lastfm.pullCandidates(
        { mode: "similar", seedArtist: seed.seedArtist, seedTrack: seed.seedTrack, limit },
        env,
      );
      similarPulled += cands.length;
      for (const c of cands) {
        await resolveInto(c);
      }
    }
    pulledCount += similarPulled;
    // Keep the `pulledCount === sum(perSource.pulled)` invariant: fold the
    // similar pulls into Last.fm's existing per-source entry (it already
    // pushed one during the trending sweep) rather than adding a second row.
    const lastfmEntry = perSource.find((p) => p.source === "lastfm");
    if (lastfmEntry) {
      lastfmEntry.pulled += similarPulled;
    } else {
      perSource.push({ source: "lastfm", pulled: similarPulled });
    }
  }

  const ids = [...resolvedIds];
  const enrichResult = await enrichAudioFeaturesForTracks(db, ids);
  const genreResult = await enrichGenresFromLastfm(db, env, ids);
  const mbResult = await enrichGenresFromMusicBrainz(db, env, ids);
  const discogsResult = await enrichGenresFromDiscogs(db, env, ids);

  return {
    pulledCount,
    perSource,
    resolvedTrackIds: ids,
    newlyCreatedTrackIds: newlyCreatedIds,
    spotifyResolvedCount,
    audioFeaturesUpdated: enrichResult.updated,
    genresUpdated: genreResult.updated,
    mbGenresUpdated: mbResult.updated,
    discogsGenresUpdated: discogsResult.updated,
    similarPulledCount: similarPulled,
  };
}

export type BucketSummary = {
  spawnedBucketIds: number[];
  joinedBucketIds: number[];
  alreadyAssignedCount: number;
};

/**
 * Step 2: bucket each resolved track. LAB-25: spawn-time naming is gone —
 * new buckets ship with the deterministic `<primary> (auto)` placeholder
 * from `defaultBucketName` and the rename step (below) names them once
 * they reach N ≥ 3 members. Naming a bucket from a single founding track
 * was the founding LAB-25 bug.
 */
export async function bucketAndName(
  db: Database,
  _env: Env,
  trackIds: readonly number[],
): Promise<BucketSummary> {
  const spawned = new Set<number>();
  const joined = new Set<number>();
  let alreadyAssignedCount = 0;

  for (const id of trackIds) {
    const result = await assignTrack(db, id);
    if (result.alreadyAssigned) {
      alreadyAssignedCount += 1;
      continue;
    }
    if (result.spawned) {
      spawned.add(result.bucketId);
    } else {
      joined.add(result.bucketId);
    }
  }

  return {
    spawnedBucketIds: [...spawned],
    joinedBucketIds: [...joined],
    alreadyAssignedCount,
  };
}

export type RenameSummary = {
  /** Buckets the eligibility rule accepted. */
  eligibleCount: number;
  /** Buckets whose name was actually written (eligible AND the agent returned). */
  renamedCount: number;
  /** Eligible buckets the namer failed on; the placeholder/old name is kept. */
  errorCount: number;
};

/** Lazy-naming threshold (LAB-25). Below this, buckets keep their placeholder. */
const LAZY_NAMING_MIN_MEMBERS = 3;
/** Centroid drift threshold — cosine < this against the last-named centroid → rename. */
const RENAME_DRIFT_THRESHOLD = 0.95;
/** Marker for un-named auto placeholder (see `defaultBucketName`). */
const PLACEHOLDER_SUFFIX = " (auto)";

/**
 * Eligibility rule for {@link renameEligibleBuckets}. Pure — exposed for
 * unit tests so we can pin the boundaries without spinning Postgres.
 *
 * Eligibility (any of):
 *  - **first-time**: still on the `(auto)` placeholder AND member_count ≥ 3.
 *  - **doubled**: previously named, member_count ≥ 2 × `last_named_at_count`.
 *  - **drift**: previously named, cosine(centroid, `last_named_centroid`) <
 *    `RENAME_DRIFT_THRESHOLD` — the bucket's geometry moved.
 *
 * Human-renamed buckets (real name AND `last_named_at_count = NULL`) are
 * deliberately ineligible: the rename pass never overwrites a user choice.
 */
export function isRenameEligible(b: {
  name: string;
  centroid: readonly number[];
  memberCount: number;
  lastNamedAtCount: number | null;
  lastNamedCentroid: readonly number[] | null;
}): boolean {
  if (b.memberCount < LAZY_NAMING_MIN_MEMBERS) return false;
  const isPlaceholder = b.name.endsWith(PLACEHOLDER_SUFFIX);

  // First-time naming: the (auto) placeholder that's grown into view.
  if (b.lastNamedAtCount === null) return isPlaceholder;

  // Already named once before — drift / doubling checks apply.
  if (b.memberCount >= 2 * b.lastNamedAtCount) return true;
  if (b.lastNamedCentroid && cosine(b.centroid, b.lastNamedCentroid) < RENAME_DRIFT_THRESHOLD) {
    return true;
  }
  return false;
}

/**
 * Aggregate a flat `track.genres[]` array across the bucket's members into a
 * descending count map. Top entries front-loaded since the agent only sees
 * the first 10.
 */
function aggregateGenres(memberGenres: readonly (readonly string[])[]): GenreCount[] {
  const counts = new Map<string, number>();
  for (const arr of memberGenres) {
    for (const g of arr) {
      if (!g) continue;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([genre, count]) => ({ genre, count }));
}

/**
 * Lazy + drift-triggered rename pass. Walks every bucket and applies the
 * eligibility rule above; eligible buckets are named via the `bucket-namer`
 * agent from their aggregated member-genre distribution + centroid audio
 * profile + a handful of sample tracks.
 *
 * Idempotent: re-running won't re-name buckets that aren't eligible. Errors
 * from the namer keep the existing name; the bucket becomes eligible again
 * on the next drift event.
 *
 * Exposed both as the daily-pipeline step body and as the backfill mutation
 * (`buckets.renamePlaceholders`) — the eligibility rule covers both cases.
 */
export async function renameEligibleBuckets(db: Database, env: Env): Promise<RenameSummary> {
  const all = await db
    .select({
      id: bucket.id,
      name: bucket.name,
      centroid: bucket.centroid,
      featureStats: bucket.featureStats,
      memberCount: bucket.memberCount,
      primaryGenre: bucket.primaryGenre,
      lastNamedAtCount: bucket.lastNamedAtCount,
      lastNamedCentroid: bucket.lastNamedCentroid,
    })
    .from(bucket);

  let eligibleCount = 0;
  let renamedCount = 0;
  let errorCount = 0;

  for (const b of all) {
    if (!isRenameEligible(b)) continue;
    eligibleCount += 1;

    // Per-bucket try/catch: a transient DB or agent failure on one bucket
    // must not abort the rest of the pass. `nameBucket` already swallows
    // its own errors → the fallback name; this catch handles DB-side
    // failures around the queries and the row update.
    try {
      const memberGenres = await db
        .select({ genres: track.genres })
        .from(bucketMember)
        .innerJoin(track, eq(track.id, bucketMember.trackId))
        .where(eq(bucketMember.bucketId, b.id));
      const sampleTracks = await db
        .select({ title: track.title, artist: track.artist })
        .from(bucketMember)
        .innerJoin(track, eq(track.id, bucketMember.trackId))
        .where(eq(bucketMember.bucketId, b.id))
        .orderBy(track.id)
        .limit(10);

      const input: BucketNamerInput = {
        primaryGenre: b.primaryGenre,
        memberCount: b.memberCount,
        genreDistribution: aggregateGenres(memberGenres.map((m) => m.genres)),
        audioProfile: b.featureStats.mean,
        sampleTracks,
      };

      const naming = await nameBucket(input, env);
      // `nameBucket` swallows its own errors and returns a `(auto)` fallback
      // on missing API key or call failure. Stamping the drift trackers from
      // that fallback would burn first-time eligibility (so the bucket sits
      // on the placeholder until membership doubles), and in drift mode
      // would clobber a real previous name. Treat it as an error and let the
      // next pass retry.
      if (naming.name.endsWith(PLACEHOLDER_SUFFIX)) {
        errorCount += 1;
        continue;
      }
      await db
        .update(bucket)
        .set({
          name: naming.name,
          color: naming.color,
          lastNamedAtCount: b.memberCount,
          lastNamedCentroid: b.centroid,
          updatedAt: sql`NOW()`,
        })
        .where(eq(bucket.id, b.id));
      renamedCount += 1;
    } catch (err) {
      console.error(`[rename-step] bucket ${b.id} failed`, err);
      errorCount += 1;
    }
  }

  return { eligibleCount, renamedCount, errorCount };
}

export type RetrainSummary = {
  skipped: boolean;
  skipReason: "no_samples" | "single_class" | null;
  sampleCount: number;
  newBroadVersionId: number | null;
};

/** Step 3: kick the broad classifier retrain. Skip semantics flow through. */
export async function retrainStep(db: Database): Promise<RetrainSummary> {
  const result = await retrainBroad(db);
  return {
    skipped: result.skipped,
    skipReason: result.skipReason ?? null,
    sampleCount: result.sampleCount,
    newBroadVersionId: result.modelVersion?.id ?? null,
  };
}

export type RecommendationsSummary = {
  newMergeCount: number;
  newSplitCount: number;
  totalPending: number;
};

/** Step 4: refresh merge/split recommendations. Idempotent. */
export async function recommendationsStep(db: Database): Promise<RecommendationsSummary> {
  const result = await evaluateBucketRecommendations(db);
  return {
    newMergeCount: result.merges.length,
    newSplitCount: result.splits.length,
    totalPending: result.totalPending,
  };
}

export type SurfaceSummary = {
  surfacedCount: number;
  refillCount: number;
  broadCount: number;
  effectiveCap: number;
};

/**
 * Step 5: load embeddings + audio for the day's resolved track IDs and run
 * the surfacing pipeline. We pass the day's pool — not the entire catalog —
 * so the cap interactions stay per-batch. Per-day caps are enforced inside
 * `runSurfacingBatch` against `surface_event` history.
 */
export async function surfaceStep(
  db: Database,
  resolvedTrackIds: readonly number[],
): Promise<SurfaceSummary> {
  const candidates = await loadCandidates(db, resolvedTrackIds);
  const result = await runSurfacingBatch(db, { candidates });
  const refillCount = result.surfaced.filter((s) => s.rankerKind === "refill").length;
  const broadCount = result.surfaced.length - refillCount;
  return {
    surfacedCount: result.surfaced.length,
    refillCount,
    broadCount,
    effectiveCap: result.effectiveCap,
  };
}

async function loadCandidates(db: Database, trackIds: readonly number[]): Promise<Candidate[]> {
  if (trackIds.length === 0) return [];
  const rows = await db
    .select({
      id: track.id,
      embedding: track.embedding,
      audioFeatures: track.audioFeatures,
      primaryGenre: track.primaryGenre,
    })
    .from(track)
    .where(inArray(track.id, [...trackIds]));
  const out: Candidate[] = [];
  for (const r of rows) {
    if (!r.embedding) continue;
    out.push({
      trackId: r.id,
      embedding: r.embedding,
      audioFeatures: r.audioFeatures as AudioFeatures | null,
      primaryGenre: r.primaryGenre,
    });
  }
  return out;
}
