import { eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, bucket, bucketMember, track } from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { evaluateBucketRecommendations } from "@/lib/bucketing/recommendations";
import { enrichGenresFromDiscogs } from "@/lib/enrichment/discogs";
import { resolveCandidate } from "@/lib/enrichment/resolve";
import { enrichGenresFromLastfm } from "@/lib/enrichment/lastfm-tags";
import { enrichGenresFromMusicBrainz } from "@/lib/enrichment/musicbrainz";
import { enrichAudioFeaturesForTracks } from "@/lib/enrichment/reccobeats";
import { retrainBroad } from "@/lib/feedback/retrain";
import { type SourceAdapter, type SourceId, createDefaultRegistry } from "@/lib/ingestion";
import type { Candidate } from "@/lib/ranking/types";
import { runSurfacingBatch } from "@/lib/surfacing/pipeline";
import type { Env } from "@/server/env";
import { nameBucket } from "@/mastra/agents/bucket-namer";

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
  audioFeaturesUpdated: number;
  genresUpdated: number;
  mbGenresUpdated: number;
  discogsGenresUpdated: number;
};

const DEFAULT_PER_SOURCE_LIMIT = 25;

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
 */
export async function pullAndEnrichTrending(
  db: Database,
  env: Env,
  options: { limitPerSource?: number; adapters?: readonly SourceAdapter[] } = {},
): Promise<PullEnrichSummary> {
  const limit = options.limitPerSource ?? DEFAULT_PER_SOURCE_LIMIT;
  const adapters = options.adapters ?? createDefaultRegistry().available(env);

  const perSource: { source: SourceId; pulled: number }[] = [];
  const resolvedIds = new Set<number>();
  const newlyCreatedIds: number[] = [];
  let pulledCount = 0;

  for (const adapter of adapters) {
    const candidates = await adapter.pullCandidates({ mode: "trending", limit }, env);
    perSource.push({ source: adapter.id, pulled: candidates.length });
    pulledCount += candidates.length;
    for (const c of candidates) {
      const result = await resolveCandidate(db, c);
      resolvedIds.add(result.trackId);
      if (result.created) newlyCreatedIds.push(result.trackId);
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
    audioFeaturesUpdated: enrichResult.updated,
    genresUpdated: genreResult.updated,
    mbGenresUpdated: mbResult.updated,
    discogsGenresUpdated: discogsResult.updated,
  };
}

export type BucketSummary = {
  spawnedBucketIds: number[];
  joinedBucketIds: number[];
  alreadyAssignedCount: number;
  namedBuckets: { bucketId: number; name: string; color: string | null }[];
};

/**
 * Step 2: bucket each resolved track. Newly-spawned buckets get auto-named
 * by the `bucket-namer` agent (one call per spawn — naming is the dominant
 * agent cost in the daily run). Naming runs after assignment so a failure
 * just leaves the deterministic placeholder in place; bucketing itself
 * never depends on the agent.
 */
export async function bucketAndName(
  db: Database,
  env: Env,
  trackIds: readonly number[],
): Promise<BucketSummary> {
  const spawned = new Set<number>();
  const joined = new Set<number>();
  let alreadyAssignedCount = 0;
  const namedBuckets: { bucketId: number; name: string; color: string | null }[] = [];

  for (const id of trackIds) {
    const result = await assignTrack(db, id);
    if (result.alreadyAssigned) {
      alreadyAssignedCount += 1;
      continue;
    }
    if (result.spawned) {
      spawned.add(result.bucketId);
      const naming = await nameNewBucket(db, env, result.bucketId);
      if (naming) namedBuckets.push(naming);
    } else {
      joined.add(result.bucketId);
    }
  }

  return {
    spawnedBucketIds: [...spawned],
    joinedBucketIds: [...joined],
    alreadyAssignedCount,
    namedBuckets,
  };
}

async function nameNewBucket(
  db: Database,
  env: Env,
  bucketId: number,
): Promise<{ bucketId: number; name: string; color: string | null } | null> {
  const [bucketRow] = await db
    .select({ primaryGenre: bucket.primaryGenre })
    .from(bucket)
    .where(eq(bucket.id, bucketId))
    .limit(1);
  if (!bucketRow) return null;

  const sample = await db
    .select({ title: track.title, artist: track.artist })
    .from(bucketMember)
    .innerJoin(track, eq(track.id, bucketMember.trackId))
    .where(eq(bucketMember.bucketId, bucketId))
    .orderBy(track.id)
    .limit(10);

  const naming = await nameBucket(
    { primaryGenre: bucketRow.primaryGenre, sampleTracks: sample },
    env,
  );

  await db
    .update(bucket)
    .set({ name: naming.name, color: naming.color, updatedAt: new Date() })
    .where(eq(bucket.id, bucketId));

  return { bucketId, name: naming.name, color: naming.color };
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
