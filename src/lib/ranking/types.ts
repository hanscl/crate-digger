import { EMBEDDING_DIM, type AudioFeatures } from "@/db/schema";

/**
 * Shared types for the Phase 4 ranking + surfacing layer. The ranking layer
 * is pure: it takes already-loaded inputs and returns scores. DB I/O is the
 * caller's job (surfacing pipeline). This separation keeps ranker logic
 * testable without testcontainers and lets evals replay rankers against
 * stored `surface_event.candidate_pool` rows in-process.
 */

export type RankerKind = "refill" | "broad";

/** The minimal track shape the rankers need: id + embedding + (optional) genre context. */
export type Candidate = {
  trackId: number;
  embedding: readonly number[];
  /** Used by `surfacedReason` text and source-mix bookkeeping; rankers ignore. */
  source?: "spotify" | "lastfm" | "viberate";
  /** Optional — only used to build human-readable explanations. */
  primaryGenre?: string | null;
  /** Audio features at decision time; persisted into `surface_event.features_at_decision`. */
  audioFeatures?: AudioFeatures | null;
};

/** A keep- or dislike-rated track, summarized for ranker math. */
export type RatedTrack = {
  trackId: number;
  embedding: readonly number[];
};

export type ScoredCandidate = {
  candidate: Candidate;
  score: number;
  subScores: Record<string, number>;
  rankerKind: RankerKind;
};

export type RefillConfig = {
  /** Penalty weight on mean dislike similarity. From `app_config.refillLambda`. */
  lambda: number;
};

/**
 * Logistic regression weights serialized into `model_version.config`. Weights
 * align with the 64-dim embedding (see `src/lib/embedding.ts`): the broad
 * classifier learns directly on the embedding so genre-dim coefficients
 * become the per-genre soft-penalty signal mandated by Constraint #4.
 *
 * `null` weights = untrained — broad ranker returns the prior probability
 * (defaulting to 0.5) so the system can still surface candidates before any
 * ratings have been collected.
 */
export type BroadConfig = {
  weights: number[] | null;
  bias: number;
  /** Number of (keep, dislike) samples the classifier was trained on. 0 = untrained. */
  trainedSampleCount: number;
  /** Class prior used when untrained. Defaults to 0.5. */
  prior?: number;
};

/**
 * Structural narrowing helpers — model_version.config is jsonb<unknown> from
 * drizzle. NaN/Infinity must be rejected: jsonb passing through Postgres
 * stays valid JSON, but a value that decoded into NaN here would silently
 * corrupt every score and every counterfactual replay. Number.isFinite
 * eliminates that whole class of bug at the trust boundary.
 */
export function isRefillConfig(x: unknown): x is RefillConfig {
  if (typeof x !== "object" || x === null) return false;
  return Number.isFinite((x as RefillConfig).lambda);
}

export function isBroadConfig(x: unknown): x is BroadConfig {
  if (typeof x !== "object" || x === null) return false;
  const c = x as BroadConfig;
  if (!Number.isFinite(c.bias) || !Number.isFinite(c.trainedSampleCount)) return false;
  if (c.weights !== null) {
    if (!Array.isArray(c.weights)) return false;
    // Length must match the embedding dim — a model trained at a different
    // dim (e.g., from a pre-refactor 128-dim embedding) would only blow up
    // at scoring time. Fail at the trust boundary instead.
    if (c.weights.length !== EMBEDDING_DIM) return false;
    for (const w of c.weights) {
      if (typeof w !== "number" || !Number.isFinite(w)) return false;
    }
  }
  if (c.prior !== undefined && !Number.isFinite(c.prior)) return false;
  return true;
}
