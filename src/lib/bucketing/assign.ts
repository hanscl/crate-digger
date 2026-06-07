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
/** Postgres SQLSTATE for unique_violation. */
const PG_UNIQUE_VIOLATION = "23505";

export async function loadSpawnThreshold(db: Database | Tx): Promise<number> {
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

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === PG_UNIQUE_VIOLATION;
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
 * Concurrency: the entire decision (membership probe → candidate fetch →
 * spawn-or-join → centroid math → writes) runs in a single transaction.
 * On join we `SELECT … FOR UPDATE` the chosen bucket so two concurrent
 * joins to the same bucket serialize and Welford sees the latest counts;
 * on either branch the `bucket_member` insert relies on the unique
 * `track_id` index — a racing caller's tx rolls back, including any
 * speculative `bucket` row, and we retry once to find the winner's
 * membership.
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
  const threshold = options.spawnThreshold ?? (await loadSpawnThreshold(db));
  const coldStartSeed = options.coldStartSeed ?? false;

  // One retry covers the only race left: the loser of a unique-on-track_id
  // collision rolls back, retries, and finds the winner's membership row.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.transaction((tx) =>
        commitAssignmentInTx(tx, trackId, threshold, coldStartSeed),
      );
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new Error(`assignTrack: exhausted retries for track id=${trackId}`);
}

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * LAB-52 — flag the bucket a freshly-ingested (discovery) track WOULD join,
 * without joining it. Persists the track's embedding/primary_genre (other
 * phases read these), runs the same primary-genre gate + nearest-centroid
 * decision as the eager path, then writes `candidate_bucket_id` /
 * `candidate_score` on the track — NO `bucket_member` insert, NO centroid
 * move. The track becomes a real member only when the user keeps it (see
 * {@link commitAssignmentInTx}, invoked from `ingestRating`). A NULL
 * `candidate_bucket_id` means "no same-genre bucket cleared the threshold — a
 * keep spawns a new bucket."
 */
export async function flagCandidateBucket(
  db: Database,
  trackId: number,
  options: { spawnThreshold?: number } = {},
): Promise<CandidateFlagResult> {
  const threshold = options.spawnThreshold ?? (await loadSpawnThreshold(db));
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ bucketId: bucketMember.bucketId })
      .from(bucketMember)
      .where(eq(bucketMember.trackId, trackId))
      .limit(1);
    if (existing) {
      // Already a committed member (e.g. a cold-start seed re-seen in
      // discovery) — nothing to flag.
      return {
        trackId,
        candidateBucketId: existing.bucketId,
        candidateScore: null,
        alreadyAssigned: true,
        wouldSpawn: false,
      };
    }

    const decision = await computeBucketDecision(tx, trackId);
    const wouldJoin =
      decision.bestBucketId !== null &&
      decision.bestSimilarity !== null &&
      decision.bestSimilarity >= threshold;
    const candidateBucketId = wouldJoin ? decision.bestBucketId : null;
    const candidateScore = wouldJoin ? decision.bestSimilarity : null;

    await tx
      .update(track)
      .set({ candidateBucketId, candidateScore, updatedAt: sql`NOW()` })
      .where(eq(track.id, trackId));

    return {
      trackId,
      candidateBucketId,
      candidateScore,
      alreadyAssigned: false,
      wouldSpawn: !wouldJoin,
    };
  });
}

export type CandidateFlagResult = {
  trackId: number;
  /** Bucket the track would join on approval, or null if it would spawn. */
  candidateBucketId: number | null;
  /** Cosine to the candidate bucket (only when it would join), else null. */
  candidateScore: number | null;
  /** Already a committed member — nothing was flagged. */
  alreadyAssigned: boolean;
  /** No same-genre bucket cleared the threshold — a keep spawns a new bucket. */
  wouldSpawn: boolean;
};

type BucketDecision = {
  embedding: number[];
  audioFeatures: AudioFeatures | null;
  primaryGenre: string | null;
  hadAudioFeatures: boolean;
  /** Nearest same-genre bucket id, or null when none shares the genre. */
  bestBucketId: number | null;
  /** Cosine to that bucket, or null when there is no candidate. */
  bestSimilarity: number | null;
};

/**
 * Pure(-ish) compute of the spawn-or-join decision for a track WITHOUT
 * mutating membership or any centroid. Persists the track's embedding +
 * primary_genre (other phases read these off `track`). Shared by the eager
 * commit path ({@link commitAssignmentInTx}) and the LAB-52 candidate-flag path
 * ({@link flagCandidateBucket}). The caller probes membership first and decides
 * join-vs-spawn against the threshold.
 */
async function computeBucketDecision(tx: Tx, trackId: number): Promise<BucketDecision> {
  const [t] = await tx.select().from(track).where(eq(track.id, trackId)).limit(1);
  if (!t) throw new Error(`assignTrack: track id=${trackId} not found`);

  // Ensure embedding + primary_genre are persisted on the track row.
  const primaryGenre = t.primaryGenre ?? derivePrimaryGenre(t.genres);
  const embedding =
    t.embedding ?? buildEmbedding({ audioFeatures: t.audioFeatures, genres: t.genres });
  if (!t.embedding || t.primaryGenre !== primaryGenre) {
    await tx
      .update(track)
      .set({ embedding, primaryGenre, updatedAt: sql`NOW()` })
      .where(eq(track.id, trackId));
  }

  // Candidate buckets sharing the track's primary genre (the LAB-45 gate).
  const candidates = await tx
    .select()
    .from(bucket)
    .where(primaryGenre ? eq(bucket.primaryGenre, primaryGenre) : isNull(bucket.primaryGenre));

  let best: { id: number; sim: number } | null = null;
  for (const b of candidates) {
    const sim = cosine(embedding, b.centroid);
    if (!best || sim > best.sim) best = { id: b.id, sim };
  }

  return {
    embedding,
    audioFeatures: t.audioFeatures,
    primaryGenre,
    hadAudioFeatures: t.audioFeatures !== null,
    bestBucketId: best?.id ?? null,
    bestSimilarity: best?.sim ?? null,
  };
}

/**
 * Commit a track into a bucket (join or spawn) WITHIN the caller's transaction,
 * updating the centroid + member_count. This is both the eager-assignment body
 * (cold-start seeding via {@link assignTrack}) and the LAB-52 approval path —
 * `ingestRating` calls it on a keep to actually join a previously-flagged
 * candidate, re-deriving the decision fresh so it handles the would-spawn case
 * and any bucket created since the flag. Idempotent: an already-member track
 * returns `alreadyAssigned` without a second insert. Clears the track's pending
 * candidate flag on commit.
 */
export async function commitAssignmentInTx(
  tx: Tx,
  trackId: number,
  threshold: number,
  coldStartSeed: boolean,
): Promise<AssignResult> {
  // 1. Probe membership first. If already assigned, we're done.
  const [existing] = await tx
    .select({ bucketId: bucketMember.bucketId, similarity: bucketMember.similarityAtJoin })
    .from(bucketMember)
    .where(eq(bucketMember.trackId, trackId))
    .limit(1);
  if (existing) {
    const [t] = await tx
      .select({ primaryGenre: track.primaryGenre, audioFeatures: track.audioFeatures })
      .from(track)
      .where(eq(track.id, trackId))
      .limit(1);
    if (!t) throw new Error(`assignTrack: track id=${trackId} not found`);
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

  const decision = await computeBucketDecision(tx, trackId);

  let result: AssignResult | null = null;
  if (
    decision.bestBucketId !== null &&
    decision.bestSimilarity !== null &&
    decision.bestSimilarity >= threshold
  ) {
    result = await joinBucketLocked(
      tx,
      trackId,
      decision.audioFeatures,
      decision.embedding,
      decision.bestBucketId,
      decision.bestSimilarity,
      { primaryGenre: decision.primaryGenre, hadAudioFeatures: decision.hadAudioFeatures },
    );
    // joinBucketLocked returns null if the bucket vanished between read and
    // lock (admin merge/split) — fall through and spawn instead.
  }
  if (!result) {
    result = await spawnBucketInTx(
      tx,
      trackId,
      decision.audioFeatures,
      decision.embedding,
      decision.primaryGenre,
      { coldStartSeed, hadAudioFeatures: decision.hadAudioFeatures },
    );
  }

  // LAB-52: now a committed member — clear any pending candidate flag.
  await tx
    .update(track)
    .set({ candidateBucketId: null, candidateScore: null })
    .where(eq(track.id, trackId));

  return result;
}

async function joinBucketLocked(
  tx: Tx,
  trackId: number,
  audio: AudioFeatures | null,
  embedding: number[],
  bucketId: number,
  similarity: number,
  ctx: { primaryGenre: string | null; hadAudioFeatures: boolean },
): Promise<AssignResult | null> {
  // Row-level lock serializes concurrent joins to the same bucket. Without
  // this, two callers race: both read memberCount=N, both write N+1, the
  // last writer wins, and the centroid silently reflects only one sample.
  const [locked] = await tx
    .select({
      id: bucket.id,
      centroid: bucket.centroid,
      memberCount: bucket.memberCount,
      featureStats: bucket.featureStats,
    })
    .from(bucket)
    .where(eq(bucket.id, bucketId))
    .for("update")
    .limit(1);
  if (!locked) return null;

  const newCentroid = updateCentroid(locked.centroid, locked.memberCount, embedding);
  const newFeatureStats: FeatureStats = audio
    ? addFeatureSample(locked.featureStats, audio)
    : locked.featureStats;

  await tx
    .update(bucket)
    .set({
      centroid: newCentroid,
      featureStats: newFeatureStats,
      memberCount: locked.memberCount + 1,
      updatedAt: sql`NOW()`,
    })
    .where(eq(bucket.id, locked.id));

  // No onConflict here: a unique-violation on track_id means we lost a race
  // and need to retry the outer probe (handled by assignTrack's retry loop).
  await tx
    .insert(bucketMember)
    .values({ bucketId: locked.id, trackId, similarityAtJoin: similarity });

  return {
    trackId,
    bucketId: locked.id,
    similarity,
    spawned: false,
    alreadyAssigned: false,
    primaryGenre: ctx.primaryGenre,
    hadAudioFeatures: ctx.hadAudioFeatures,
  };
}

async function spawnBucketInTx(
  tx: Tx,
  trackId: number,
  audio: AudioFeatures | null,
  embedding: number[],
  primaryGenre: string | null,
  ctx: { coldStartSeed: boolean; hadAudioFeatures: boolean },
): Promise<AssignResult> {
  const seedStats = audio ? addFeatureSample(emptyFeatureStats(), audio) : emptyFeatureStats();

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

  // Unique on bucket_member.track_id is the race-loser detector. If a
  // concurrent caller already inserted membership for this track, this
  // insert raises 23505 and the entire transaction (including the bucket
  // row above) rolls back — no orphan bucket left behind.
  await tx.insert(bucketMember).values({ bucketId: row.id, trackId, similarityAtJoin: 1.0 });

  return {
    trackId,
    bucketId: row.id,
    similarity: 1.0,
    spawned: true,
    alreadyAssigned: false,
    primaryGenre,
    hadAudioFeatures: ctx.hadAudioFeatures,
  };
}
