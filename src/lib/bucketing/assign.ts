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
      return await runAssignTransaction(db, trackId, threshold, coldStartSeed);
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new Error(`assignTrack: exhausted retries for track id=${trackId}`);
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function runAssignTransaction(
  db: Database,
  trackId: number,
  threshold: number,
  coldStartSeed: boolean,
): Promise<AssignResult> {
  return db.transaction(async (tx) => {
    // 1. Probe membership first. Cheap; if the track is already in a bucket,
    //    we're done before touching anything else.
    const [existing] = await tx
      .select({ bucketId: bucketMember.bucketId, similarity: bucketMember.similarityAtJoin })
      .from(bucketMember)
      .where(eq(bucketMember.trackId, trackId))
      .limit(1);

    const [t] = await tx.select().from(track).where(eq(track.id, trackId)).limit(1);
    if (!t) throw new Error(`assignTrack: track id=${trackId} not found`);

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

    // 2. Ensure embedding + primary_genre are persisted on the track row.
    //    Other phases read these directly from `track`.
    const primaryGenre = t.primaryGenre ?? derivePrimaryGenre(t.genres);
    const embedding =
      t.embedding ?? buildEmbedding({ audioFeatures: t.audioFeatures, genres: t.genres });
    if (!t.embedding || t.primaryGenre !== primaryGenre) {
      await tx
        .update(track)
        .set({ embedding, primaryGenre, updatedAt: sql`NOW()` })
        .where(eq(track.id, trackId));
    }

    // 3. Find candidate buckets sharing the track's primary genre.
    const candidates = await tx
      .select()
      .from(bucket)
      .where(primaryGenre ? eq(bucket.primaryGenre, primaryGenre) : isNull(bucket.primaryGenre));

    let best: { id: number; sim: number } | null = null;
    for (const b of candidates) {
      const sim = cosine(embedding, b.centroid);
      if (!best || sim > best.sim) best = { id: b.id, sim };
    }

    const hadAudioFeatures = t.audioFeatures !== null;

    if (best && best.sim >= threshold) {
      const joined = await joinBucketLocked(
        tx,
        trackId,
        t.audioFeatures,
        embedding,
        best.id,
        best.sim,
        { primaryGenre, hadAudioFeatures },
      );
      if (joined) return joined;
      // The bucket vanished between candidate read and lock (deleted by an
      // admin merge/split, say). Fall through and spawn instead.
    }

    return spawnBucketInTx(tx, trackId, t.audioFeatures, embedding, primaryGenre, {
      coldStartSeed,
      hadAudioFeatures,
    });
  });
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
