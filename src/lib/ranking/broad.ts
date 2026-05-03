import { EMBEDDING_DIM } from "@/db/schema";
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
  let s = 0;
  const n = Math.min(w.length, x.length);
  for (let i = 0; i < n; i++) {
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

/**
 * Score a single candidate. Untrained config → emits the prior so surfacing
 * still has a usable score. Sub-scores include the raw logit for evals.
 */
export function scoreBroad(candidate: Candidate, config: BroadConfig): ScoredCandidate {
  if (!config.weights) {
    const p = config.prior ?? DEFAULT_PRIOR;
    return {
      candidate,
      score: p,
      subScores: { logit: 0, prior: p, untrained: 1 },
      rankerKind: "broad",
    };
  }
  const z = dot(config.weights, candidate.embedding) + config.bias;
  const p = sigmoid(z);
  return {
    candidate,
    score: p,
    subScores: { logit: z, prior: config.prior ?? DEFAULT_PRIOR, untrained: 0 },
    rankerKind: "broad",
  };
}

export function scoreBroadBatch(
  candidates: readonly Candidate[],
  config: BroadConfig,
): ScoredCandidate[] {
  return candidates.map((c) => scoreBroad(c, config));
}
