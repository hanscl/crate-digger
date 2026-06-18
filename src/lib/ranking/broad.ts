import { EMBEDDING_DIM } from "@/db/schema";
import { broadBreakoutPenalty } from "./types";
import type { BroadConfig, Candidate, ScoredCandidate } from "./types";

/**
 * Broad-discovery classifier (explore mode).
 *
 * Binary logistic regression on the 64-dim track embedding:
 *
 *   P(keep | x) = σ(w·x + b)
 *
 * Trained with batch gradient descent + L2 regularization. The dataset is
 * always small (rating volume per user) so we don't need a SGD pipeline or
 * an external library — ~50 lines of math is enough and keeps the model
 * fully reproducible from the stored weights.
 *
 * Constraint #4 (soft penalties): no genre is ever excluded. Disliked-genre
 * dimensions naturally pick up negative coefficients during training; their
 * candidates score lower but stay in the pool. The ranker never filters.
 *
 * Untrained behavior: when called with `BroadConfig.weights === null` (e.g.,
 * the bootstrap version before the first retrain) every candidate receives
 * the configured prior — the surfacing layer can still produce an ordering
 * via tie-breakers (deterministic by trackId) so the system is usable from
 * day 0.
 */

export const DEFAULT_PRIOR = 0.5;

export type BroadTrainingSample = {
  /** Length must equal `EMBEDDING_DIM`. */
  embedding: readonly number[];
  /** 1 = keep, 0 = dislike. Neutral / defer ratings should be filtered upstream. */
  label: 0 | 1;
};

export type BroadTrainOptions = {
  /** Iterations of full-batch gradient descent. Default: 200. */
  iterations?: number;
  /** Step size. Default: 0.5 — fine for 64-dim normalized features. */
  learningRate?: number;
  /** L2 penalty on weights (NOT bias). Default: 0.01. Keeps coefficients tame on tiny datasets. */
  l2?: number;
};

export type BroadTrainResult = {
  config: BroadConfig;
  /** Final mean cross-entropy loss on the training set. */
  finalLoss: number;
  /** Number of iterations actually run. */
  iterations: number;
};

const DEFAULT_ITERATIONS = 200;
const DEFAULT_LEARNING_RATE = 0.5;
const DEFAULT_L2 = 0.01;

function sigmoid(z: number): number {
  // Clamp to avoid overflow at extreme weights.
  if (z >= 36) return 1 - 1e-16;
  if (z <= -36) return 1e-16;
  return 1 / (1 + Math.exp(-z));
}

function dot(w: readonly number[], x: readonly number[]): number {
  // Strict dim check — silently truncating to the shorter side would mask
  // embedding/config corruption (e.g., a model trained at one EMBEDDING_DIM
  // being scored against a candidate built at another). Better to fail loudly.
  if (w.length !== x.length) {
    throw new Error(`dot: dim mismatch ${w.length} vs ${x.length}`);
  }
  let s = 0;
  for (let i = 0; i < w.length; i++) {
    s += (w[i] ?? 0) * (x[i] ?? 0);
  }
  return s;
}

/**
 * Train a binary LR classifier on a labeled set of embeddings. Returns the
 * weights + bias serializable into `model_version.config`. With < 2 distinct
 * labels (e.g., only keeps, no dislikes yet) returns an untrained config —
 * the model can't learn a decision boundary from one class.
 */
export function trainBroadClassifier(
  samples: readonly BroadTrainingSample[],
  options: BroadTrainOptions = {},
): BroadTrainResult {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const lr = options.learningRate ?? DEFAULT_LEARNING_RATE;
  const l2 = options.l2 ?? DEFAULT_L2;

  if (samples.length === 0) {
    return {
      config: { weights: null, bias: 0, trainedSampleCount: 0, prior: DEFAULT_PRIOR },
      finalLoss: 0,
      iterations: 0,
    };
  }

  const positives = samples.filter((s) => s.label === 1).length;
  const negatives = samples.length - positives;
  if (positives === 0 || negatives === 0) {
    // One-class data leaks no decision boundary. Stay untrained, but bake the
    // empirical class prior into the config so cold-start surfacing reflects
    // observed bias instead of 50/50.
    return {
      config: {
        weights: null,
        bias: 0,
        trainedSampleCount: samples.length,
        prior: positives / samples.length,
      },
      finalLoss: 0,
      iterations: 0,
    };
  }

  const dim = samples[0]?.embedding.length ?? EMBEDDING_DIM;
  for (const s of samples) {
    if (s.embedding.length !== dim) {
      throw new Error(`trainBroadClassifier: dim mismatch, expected ${dim}`);
    }
  }

  const weights: number[] = Array.from({ length: dim }, () => 0);
  let bias = 0;
  let lastLoss = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const gradW: number[] = Array.from({ length: dim }, () => 0);
    let gradB = 0;
    let loss = 0;

    for (const s of samples) {
      const z = dot(weights, s.embedding) + bias;
      const p = sigmoid(z);
      const err = p - s.label; // ∂L/∂z for binary cross-entropy
      for (let i = 0; i < dim; i++) {
        gradW[i] = (gradW[i] ?? 0) + err * (s.embedding[i] ?? 0);
      }
      gradB += err;
      const ll = s.label === 1 ? Math.log(Math.max(p, 1e-16)) : Math.log(Math.max(1 - p, 1e-16));
      loss -= ll;
    }

    const n = samples.length;
    for (let i = 0; i < dim; i++) {
      const g = (gradW[i] ?? 0) / n + l2 * (weights[i] ?? 0);
      weights[i] = (weights[i] ?? 0) - lr * g;
    }
    bias -= lr * (gradB / n);
    lastLoss = loss / n;
  }

  return {
    config: {
      weights,
      bias,
      trainedSampleCount: samples.length,
      prior: positives / samples.length,
    },
    finalLoss: lastLoss,
    iterations,
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * LAB-92 — the soft mainstream down-weight for one candidate:
 * `breakoutPenalty · (1 − breakout)`. Returns 0 when the version's knob is 0
 * or the candidate carries no breakout reading (Spotify/Last.fm, or a legacy
 * pool entry) — "no signal → no penalty" (Constraints #3/#4). `breakout` is
 * clamped to [0,1] defensively: it is clamp01'd at ingestion, but the value
 * arrives via jsonb (`raw_payload`/`candidate_pool`), a trust boundary.
 */
function breakoutDownweight(candidate: Candidate, config: BroadConfig): number {
  const knob = broadBreakoutPenalty(config);
  const breakout = candidate.breakout;
  if (knob <= 0 || breakout === null || breakout === undefined || !Number.isFinite(breakout)) {
    return 0;
  }
  return knob * (1 - clamp01(breakout));
}

/**
 * Score a single candidate. Untrained config → emits the prior so surfacing
 * still has a usable score. Sub-scores include the raw logit for evals.
 *
 * LAB-92 — after the base P(keep), a soft mainstream down-weight is subtracted
 * for candidates carrying a paid-engine breakout score (see
 * {@link breakoutDownweight}): a surging-but-obscure find is left ~untouched
 * while a mainstream one is pushed down, clamped to [0,1] — never an exclude
 * (Constraint #4). The breakout input is read off the candidate (frozen onto
 * the pool entry at surface time), never live, so replay stays exact
 * (Constraint #3). Applied in BOTH branches so breakouts are preferred from
 * day 0 (untrained), and exposed as `subScores.breakoutPenalty` for
 * why-surfaced + evals.
 */
export function scoreBroad(candidate: Candidate, config: BroadConfig): ScoredCandidate {
  const breakoutPenalty = breakoutDownweight(candidate, config);
  if (!config.weights) {
    const p = config.prior ?? DEFAULT_PRIOR;
    return {
      candidate,
      score: clamp01(p - breakoutPenalty),
      subScores: { logit: 0, prior: p, untrained: 1, breakoutPenalty },
      rankerKind: "broad",
    };
  }
  const z = dot(config.weights, candidate.embedding) + config.bias;
  const p = sigmoid(z);
  return {
    candidate,
    score: clamp01(p - breakoutPenalty),
    subScores: { logit: z, prior: config.prior ?? DEFAULT_PRIOR, untrained: 0, breakoutPenalty },
    rankerKind: "broad",
  };
}

export function scoreBroadBatch(
  candidates: readonly Candidate[],
  config: BroadConfig,
): ScoredCandidate[] {
  return candidates.map((c) => scoreBroad(c, config));
}
