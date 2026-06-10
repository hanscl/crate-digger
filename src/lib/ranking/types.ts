import { EMBEDDING_DIM, type AudioFeatures } from "@/db/schema";
import type { GenreGate } from "@/lib/bucketing/genre-scope";

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
  /** Used by the refill winner-eligibility gate and human-readable explanations. */
  primaryGenre?: string | null;
  /**
   * Audio features at decision time; persisted into
   * `surface_event.features_at_decision`. LAB-36: also the null-audio damping
   * key for refill scoring — null/absent means the embedding's audio dims are
   * neutral fills, so weighted comparisons degrade to plain cosine.
   */
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
  /**
   * LAB-36 — comparison-time scale on the 6 audio embedding dims (see
   * `weightedCosine`). From `app_config.audioWeight`. Optional: legacy
   * `{lambda}`-only configs predate it and MUST keep replaying byte-identically,
   * so absence means 1 (plain cosine) — see {@link refillAudioWeight}.
   */
  audioWeight?: number;
  /**
   * LAB-36 — which genre-compatibility predicate gates bucket JOINs, refill
   * winners, and counterfactual replay under this version. Absence means
   * 'exact' (the LAB-45 rule) so old versions replay under the gate they were
   * scored with — see {@link refillGenreGate}.
   */
  genreGate?: GenreGate;
};

/**
 * LAB-36 — default audioWeight, chosen from the grid sweep over the cohort
 * fixture (scripts/lab36-grid.ts): the minimum of the mandated W ≥ ~2.5 range,
 * where all three named cases pass while similarity-scale inflation and
 * cross-lane accretion stay smallest. Pinned in lock-step with the
 * `app_config.audio_weight` column default (migration 0012) and the
 * reassignment-replay eval.
 */
export const DEFAULT_AUDIO_WEIGHT = 2.5;

/** Effective audio weight for a refill config; legacy configs → 1 (plain cosine). */
export function refillAudioWeight(config: RefillConfig): number {
  return config.audioWeight ?? 1;
}

/** Effective genre gate for a refill config; legacy configs → 'exact' (LAB-45). */
export function refillGenreGate(config: RefillConfig): GenreGate {
  return config.genreGate ?? "exact";
}

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
  const c = x as RefillConfig;
  if (!Number.isFinite(c.lambda)) return false;
  // LAB-36 fields are optional (legacy {lambda}-only configs stay valid) but
  // when present must be sane: a NaN/zero/negative audioWeight would corrupt
  // every membership decision and every replay; an unknown gate string would
  // silently fall back to a behavior the version never had.
  if (c.audioWeight !== undefined) {
    if (!Number.isFinite(c.audioWeight) || c.audioWeight < 1) return false;
  }
  if (c.genreGate !== undefined) {
    if (c.genreGate !== "exact" && c.genreGate !== "slot-overlap") return false;
  }
  return true;
}

export function isBroadConfig(x: unknown): x is BroadConfig {
  if (typeof x !== "object" || x === null) return false;
  const c = x as BroadConfig;
  if (!Number.isFinite(c.bias)) return false;
  // trainedSampleCount is a count: non-negative integer. Floats or negatives
  // would silently miscalibrate cold-start logic and persist into evals.
  if (!Number.isInteger(c.trainedSampleCount) || c.trainedSampleCount < 0) return false;
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
  // prior is a probability: must lie in [0, 1]. An out-of-range value would
  // produce nonsense untrained scores and skew the surfacing pipeline.
  if (c.prior !== undefined) {
    if (!Number.isFinite(c.prior) || c.prior < 0 || c.prior > 1) return false;
  }
  return true;
}
