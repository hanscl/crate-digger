import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  type AudioFeatures,
  appConfig,
  bucket,
  bucketMember,
  type BucketMemberOrigin,
  type FeatureStats,
  modelVersion,
  track,
} from "@/db/schema";
import { buildEmbedding, derivePrimaryGenre, weightedCosine } from "@/lib/embedding";
import {
  DEFAULT_AUDIO_WEIGHT,
  isRefillConfig,
  refillAudioWeight,
  refillGenreGate,
} from "@/lib/ranking/types";
import { addFeatureSample, emptyFeatureStats, updateCentroid } from "./centroid";
import { type GenreGate, genreScopeCompatible } from "./genre-scope";

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
  /**
   * LAB-61 — provenance stamped on the bucket_member row. Required (no
   * default) so every eager-assignment caller decides what kind of membership
   * it is creating; the discovery approval path stamps its own
   * 'discovery_keep' via {@link commitAssignmentInTx} instead.
   */
  origin: BucketMemberOrigin;
  /** Cosine threshold above which a track joins the nearest bucket. Falls back to app_config. */
  spawnThreshold?: number;
  /** LAB-36 — audio-dim weight override (tests/evals). Falls back to {@link loadAssignConfig}. */
  audioWeight?: number;
  /** LAB-36 — genre-gate override (tests/evals). Falls back to {@link loadAssignConfig}. */
  genreGate?: GenreGate;
  /** Mark a freshly-spawned bucket as a cold-start seed (Setup-screen playlist flow). */
  coldStartSeed?: boolean;
};

const FALLBACK_SPAWN_THRESHOLD = 0.7;
/** Postgres SQLSTATE for unique_violation. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * LAB-36 — the comparison config for spawn-or-join decisions: which genre
 * gate filters candidate buckets and how hard the audio dims weigh in the
 * cosine. One value pair per decision so the JOIN gate and the surfacing
 * winner gate stay one metric family.
 */
export type BucketGateConfig = {
  audioWeight: number;
  genreGate: GenreGate;
};

export type AssignConfig = BucketGateConfig & { spawnThreshold: number };

/**
 * Resolve the live assignment config. spawnThreshold comes straight from
 * app_config; audioWeight/genreGate come from the ACTIVE refill
 * model_version's config so membership decisions and refill scoring always
 * run the same metric (Constraint #3: the version IS the config record).
 * Resolution:
 *
 *   - active refill version with LAB-36 fields → its audioWeight/genreGate;
 *   - active refill version with a legacy {lambda}-only config (pre-LAB-36
 *     install mid-migration, before the reconcile sweep mints the upgrade
 *     version) → weight 1 + 'exact', preserving old behavior exactly;
 *   - no active refill version (fresh install before first surfacing
 *     bootstrap) → app_config.audio_weight + 'slot-overlap', matching the
 *     config `ensureActiveModelVersion` will mint.
 */
export async function loadAssignConfig(db: Database | Tx): Promise<AssignConfig> {
  const [cfg] = await db
    .select({
      spawnThreshold: appConfig.spawnThreshold,
      audioWeight: appConfig.audioWeight,
      activeRefillVersionId: appConfig.activeRefillVersionId,
    })
    .from(appConfig)
    .limit(1);
  const spawnThreshold = cfg?.spawnThreshold ?? FALLBACK_SPAWN_THRESHOLD;
  if (cfg?.activeRefillVersionId) {
    const [active] = await db
      .select({ config: modelVersion.config })
      .from(modelVersion)
      .where(eq(modelVersion.id, cfg.activeRefillVersionId))
      .limit(1);
    if (active && isRefillConfig(active.config)) {
      return {
        spawnThreshold,
        audioWeight: refillAudioWeight(active.config),
        genreGate: refillGenreGate(active.config),
      };
    }
  }
  return {
    spawnThreshold,
    audioWeight: cfg?.audioWeight ?? DEFAULT_AUDIO_WEIGHT,
    genreGate: "slot-overlap",
  };
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
 *   1. Only buckets passing the config's genre gate are considered
 *      (LAB-36: 'slot-overlap' — ≥1 shared genre slot between the track's
 *      embedding and the bucket's centroid genre mass; legacy 'exact' —
 *      same primary genre, null===null). A track compatible with no
 *      existing bucket spawns a new one regardless of how close it is to
 *      other centroids.
 *   2. Among compatible buckets, the closest centroid by audio-weighted
 *      cosine wins. If max similarity ≥ `spawnThreshold` the track joins;
 *      otherwise it spawns. Tracks with NULL audio_features compare at
 *      weight 1 (their audio dims are neutral 0.5 fills — up-weighting
 *      those would make them promiscuous joiners).
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
  options: AssignOptions,
): Promise<AssignResult> {
  const loaded = await loadAssignConfig(db);
  const threshold = options.spawnThreshold ?? loaded.spawnThreshold;
  const gate: BucketGateConfig = {
    audioWeight: options.audioWeight ?? loaded.audioWeight,
    genreGate: options.genreGate ?? loaded.genreGate,
  };
  const coldStartSeed = options.coldStartSeed ?? false;

  // One retry covers the only race left: the loser of a unique-on-track_id
  // collision rolls back, retries, and finds the winner's membership row.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.transaction((tx) =>
        commitAssignmentInTx(tx, trackId, threshold, {
          origin: options.origin,
          coldStartSeed,
          gate,
        }),
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
 * phases read these), runs the same genre gate + weighted nearest-centroid
 * decision as the eager path, then writes `candidate_bucket_id` /
 * `candidate_score` on the track — NO `bucket_member` insert, NO centroid
 * move. The track becomes a real member only when the user keeps it (see
 * {@link commitAssignmentInTx}, invoked from `ingestRating`). A NULL
 * `candidate_bucket_id` means "no gate-compatible bucket cleared the
 * threshold — a keep spawns a new bucket."
 */
export async function flagCandidateBucket(
  db: Database,
  trackId: number,
  options: { spawnThreshold?: number; audioWeight?: number; genreGate?: GenreGate } = {},
): Promise<CandidateFlagResult> {
  const loaded = await loadAssignConfig(db);
  const threshold = options.spawnThreshold ?? loaded.spawnThreshold;
  const gate: BucketGateConfig = {
    audioWeight: options.audioWeight ?? loaded.audioWeight,
    genreGate: options.genreGate ?? loaded.genreGate,
  };
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ bucketId: bucketMember.bucketId })
      .from(bucketMember)
      .where(eq(bucketMember.trackId, trackId))
      .limit(1);
    if (existing) {
      // Already a committed member (e.g. a cold-start seed re-seen in
      // discovery) — nothing to flag. candidateBucketId stays null: per its
      // contract it holds a *pending* candidate, not a live membership.
      return {
        trackId,
        candidateBucketId: null,
        candidateScore: null,
        alreadyAssigned: true,
        wouldSpawn: false,
      };
    }

    const decision = await computeBucketDecision(tx, trackId, gate);
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
  /** Weighted cosine to the candidate bucket (only when it would join), else null. */
  candidateScore: number | null;
  /** Already a committed member — nothing was flagged. */
  alreadyAssigned: boolean;
  /** No gate-compatible bucket cleared the threshold — a keep spawns a new bucket. */
  wouldSpawn: boolean;
};

type BucketDecision = {
  embedding: number[];
  audioFeatures: AudioFeatures | null;
  primaryGenre: string | null;
  hadAudioFeatures: boolean;
  /** Nearest gate-compatible bucket id, or null when none is compatible. */
  bestBucketId: number | null;
  /** Weighted cosine to that bucket, or null when there is no candidate. */
  bestSimilarity: number | null;
};

/**
 * Pure(-ish) compute of the spawn-or-join decision for a track WITHOUT
 * mutating membership or any centroid. Persists the track's embedding +
 * primary_genre (other phases read these off `track`). Shared by the eager
 * commit path ({@link commitAssignmentInTx}) and the LAB-52 candidate-flag path
 * ({@link flagCandidateBucket}). The caller probes membership first and decides
 * join-vs-spawn against the threshold.
 *
 * LAB-36: candidate buckets are ALL buckets passing the config's genre gate
 * (fetch-all + filter in JS — tens of buckets, nothing queries HNSW here);
 * nearest is by `weightedCosine` at the config's audioWeight. NULL-AUDIO
 * DAMPING: when the track's audio_features IS NULL its embedding carries
 * neutral 0.5 audio fills, so its comparisons degrade to weight 1 — otherwise
 * up-weighting the neutral dims would make featureless tracks similar to
 * everything and they'd converge into whichever bucket came first.
 */
async function computeBucketDecision(
  tx: Tx,
  trackId: number,
  gate: BucketGateConfig,
): Promise<BucketDecision> {
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

  const audioWeight = t.audioFeatures === null ? 1 : gate.audioWeight;
  const allBuckets = await tx.select().from(bucket);

  let best: { id: number; sim: number } | null = null;
  for (const b of allBuckets) {
    if (
      !genreScopeCompatible(
        gate.genreGate,
        { primaryGenre, embedding },
        { primaryGenre: b.primaryGenre, centroid: b.centroid },
      )
    ) {
      continue;
    }
    const sim = weightedCosine(embedding, b.centroid, audioWeight);
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
 * returns `alreadyAssigned` without a second insert — and never rewrites the
 * existing row's origin (a keep on a cold-start seed leaves it a seed).
 * Clears the track's pending candidate flag on commit.
 */
export async function commitAssignmentInTx(
  tx: Tx,
  trackId: number,
  threshold: number,
  options: { origin: BucketMemberOrigin; coldStartSeed: boolean; gate: BucketGateConfig },
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

  const decision = await computeBucketDecision(tx, trackId, options.gate);

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
      {
        origin: options.origin,
        primaryGenre: decision.primaryGenre,
        hadAudioFeatures: decision.hadAudioFeatures,
      },
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
      {
        origin: options.origin,
        coldStartSeed: options.coldStartSeed,
        hadAudioFeatures: decision.hadAudioFeatures,
      },
    );
  }

  // LAB-52: now a committed member — clear any pending candidate flag.
  await tx
    .update(track)
    .set({ candidateBucketId: null, candidateScore: null, updatedAt: sql`NOW()` })
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
  ctx: { origin: BucketMemberOrigin; primaryGenre: string | null; hadAudioFeatures: boolean },
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
    .values({ bucketId: locked.id, trackId, similarityAtJoin: similarity, origin: ctx.origin });

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
  ctx: { origin: BucketMemberOrigin; coldStartSeed: boolean; hadAudioFeatures: boolean },
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
  await tx
    .insert(bucketMember)
    .values({ bucketId: row.id, trackId, similarityAtJoin: 1.0, origin: ctx.origin });

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
