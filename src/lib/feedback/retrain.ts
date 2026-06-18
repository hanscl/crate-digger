import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type ModelVersion, rating, track } from "@/db/schema";
import {
  type BroadTrainResult,
  type BroadTrainingSample,
  trainBroadClassifier,
} from "@/lib/ranking/broad";
import type { BroadConfig } from "@/lib/ranking/types";
import { bumpModelVersion, getActiveConfig } from "@/lib/ranking/version";

/**
 * Broad classifier retrain entrypoint. Phase 6's daily cron and the Console
 * "Retrain now" button both land here.
 *
 * Flow:
 *   1. Pull every keep/dislike rating in the training window, joined to its
 *      track's embedding. Defer / neutral are excluded — no signal for a
 *      binary classifier.
 *   2. Hand the (embedding, label) pairs to `trainBroadClassifier`.
 *   3. Bump the broad model version with the new config + window stamps.
 *
 * No-op short-circuit: when there are no labeled samples we skip the bump —
 * an empty retrain would mint a duplicate of the bootstrap version and
 * pollute lineage.
 *
 * The retrain reads ratings unconditionally from the global pool. We don't
 * scope to "ratings tagged with version N" — the trainer's job is to learn
 * the user's CURRENT taste from all evidence. Per Constraint #3 the rating's
 * tagged version is what evals attribute decisions to, not what the trainer
 * filters on.
 */

export type RetrainBroadOptions = {
  /** Lower bound (inclusive) on rating.rated_at. Defaults to all-time. */
  windowStart?: Date;
  /** Upper bound (inclusive) on rating.rated_at. Defaults to now. */
  windowEnd?: Date;
  /** Free-text annotation surfaced in the Console. */
  note?: string;
  /** Forwarded to `trainBroadClassifier` — primarily for tests pinning iter count. */
  iterations?: number;
  learningRate?: number;
  l2?: number;
};

export type RetrainBroadResult = {
  /** Null when the retrain produced no samples and was skipped. */
  modelVersion: ModelVersion | null;
  /** The classifier output (config, finalLoss, iterations). Always populated. */
  training: BroadTrainResult;
  sampleCount: number;
  /** The window actually used (defaults filled in). */
  windowStart: Date | null;
  windowEnd: Date;
  skipped: boolean;
  skipReason?: "no_samples" | "single_class";
};

export async function retrainBroad(
  db: Database,
  options: RetrainBroadOptions = {},
): Promise<RetrainBroadResult> {
  const windowStart = options.windowStart ?? null;
  const windowEnd = options.windowEnd ?? new Date();

  const samples = await loadTrainingSamples(db, windowStart, windowEnd);

  if (samples.length === 0) {
    const empty = trainBroadClassifier([], options);
    return {
      modelVersion: null,
      training: empty,
      sampleCount: 0,
      windowStart,
      windowEnd,
      skipped: true,
      skipReason: "no_samples",
    };
  }

  const positives = samples.filter((s) => s.label === 1).length;
  const negatives = samples.length - positives;
  const training = trainBroadClassifier(samples, {
    iterations: options.iterations,
    learningRate: options.learningRate,
    l2: options.l2,
  });

  // Single-class training data leaves us with the same `weights: null` shape
  // as the bootstrap version. Skipping the bump means the active broad
  // version stays put until enough negatives arrive to actually learn a
  // boundary. We still record the empirical prior in `training.config.prior`
  // for the caller's telemetry, but don't pollute the version chain.
  if (positives === 0 || negatives === 0) {
    return {
      modelVersion: null,
      training,
      sampleCount: samples.length,
      windowStart,
      windowEnd,
      skipped: true,
      skipReason: "single_class",
    };
  }

  // LAB-92 — carry the active broad version's frozen breakout-penalty knob
  // forward. `trainBroadClassifier` only emits weights/bias/prior/
  // trainedSampleCount, so without this every retrain would drop
  // `breakoutPenalty` (→ 0 via the legacy fallback) and silently disable the
  // mainstream down-weight until the next deploy/reconcile re-installed it.
  // Mirrors the params router carrying config forward on a knob bump (a frozen
  // value is preserved, never recomputed; absent on a legacy config stays absent).
  const activeBroad = await getActiveConfig(db, "broad");
  const config: BroadConfig = {
    ...training.config,
    ...(activeBroad.breakoutPenalty !== undefined
      ? { breakoutPenalty: activeBroad.breakoutPenalty }
      : {}),
  };
  const newVersion = await bumpModelVersion(db, "broad", config, {
    note: options.note ?? `retrain n=${samples.length} loss=${training.finalLoss.toFixed(4)}`,
    trainingWindowStart: windowStart ?? undefined,
    trainingWindowEnd: windowEnd,
  });

  return {
    modelVersion: newVersion,
    training,
    sampleCount: samples.length,
    windowStart,
    windowEnd,
    skipped: false,
  };
}

async function loadTrainingSamples(
  db: Database,
  windowStart: Date | null,
  windowEnd: Date,
): Promise<BroadTrainingSample[]> {
  const conditions = [
    inArray(rating.decision, ["keep", "dislike"] as const),
    isNotNull(track.embedding),
    lte(rating.ratedAt, windowEnd),
  ];
  if (windowStart) conditions.push(gte(rating.ratedAt, windowStart));

  const rows = await db
    .select({
      trackId: rating.trackId,
      ratedAt: rating.ratedAt,
      decision: rating.decision,
      embedding: track.embedding,
    })
    .from(rating)
    .innerJoin(track, eq(track.id, rating.trackId))
    .where(and(...conditions));

  // A track can be rated more than once (user changes mind). We use the
  // freshest per-track signal: dedupe by trackId, last-write-wins by
  // ratedAt. Without this a "keep then dislike" track would contribute two
  // contradictory samples with identical embeddings — bad for convergence.
  // Cheap at our scale (rating count is bounded by what one user can label).
  const latestByTrack = new Map<
    number,
    { decision: "keep" | "dislike"; embedding: number[]; ratedAt: Date }
  >();
  for (const r of rows) {
    if (r.embedding === null) continue;
    if (r.decision !== "keep" && r.decision !== "dislike") continue;
    const prior = latestByTrack.get(r.trackId);
    if (!prior || r.ratedAt.getTime() > prior.ratedAt.getTime()) {
      latestByTrack.set(r.trackId, {
        decision: r.decision,
        embedding: r.embedding,
        ratedAt: r.ratedAt,
      });
    }
  }
  return Array.from(latestByTrack.values()).map((r) => ({
    embedding: r.embedding,
    label: r.decision === "keep" ? 1 : 0,
  }));
}
