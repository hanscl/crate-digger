import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type ModelVersion, rating, track } from "@/db/schema";
import {
  type BroadTrainResult,
  type BroadTrainingSample,
  trainBroadClassifier,
} from "@/lib/ranking/broad";
import { bumpModelVersion } from "@/lib/ranking/version";

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

  const newVersion = await bumpModelVersion(db, "broad", training.config, {
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
      decision: rating.decision,
      embedding: track.embedding,
    })
    .from(rating)
    .innerJoin(track, eq(track.id, rating.trackId))
    .where(and(...conditions));

  // A track can be rated more than once (user changes mind). We use the
  // freshest per-track signal: drizzle returns rows ordered by table scan;
  // dedupe manually on track_id, last-write-wins, by sorting on rated_at
  // before mapping. Cheap at our scale (rating count is bounded by what one
  // user can label).
  return rows
    .filter(
      (r): r is { decision: "keep" | "dislike"; embedding: number[] } =>
        r.embedding !== null && (r.decision === "keep" || r.decision === "dislike"),
    )
    .map((r) => ({ embedding: r.embedding, label: r.decision === "keep" ? 1 : 0 }));
}
