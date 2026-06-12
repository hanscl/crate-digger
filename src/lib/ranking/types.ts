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
  source?: "spotify" | "lastfm" | "viberate" | "tiktok";
  /** Used by the refill winner-eligibility gate and human-readable explanations. */
  primaryGenre?: string | null;
  /**
   * LAB-73 — the track's artist (`track.artist`). Drives the surfacing
   * diversity quota (≤1 surfaced per artist/run) and the refill familiarity
   * penalty. Optional so legacy/synthetic candidates without it bypass both
   * mechanisms (the quota and penalty no-op on an absent/empty artist).
   */
  artist?: string | null;
  /**
   * Audio features at decision time; persisted into
   * `surface_event.features_at_decision`. Also the null-audio coverage key for
   * refill scoring: null/absent means the embedding's audio dims are neutral
   * 0.5 fills, so refill compares this candidate on genre dims only under a
   * gated version (LAB-48 — `weightedCosine(.,.,0)`), or, on a legacy gate-off
   * version, degrades to plain cosine over those fills (the old LAB-36 damping).
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
  /**
   * LAB-73 — soft per-candidate refill-score penalty applied when the
   * candidate's artist is "familiar" (the user has keep-rated that artist).
   * This is the EFFECTIVE penalty, already scaled by the novelty knob at
   * version-mint time (`familiarityPenaltyFromNovelty`), so it is frozen into
   * the version like {@link audioWeight} — scoring never reads live novelty
   * and counterfactual replay stays config-deterministic (Constraints #2/#3).
   * Optional: legacy configs predate it and MUST keep replaying byte-
   * identically, so absence means 0 (no penalty) — see
   * {@link refillFamiliarityPenalty}.
   */
  familiarityPenalty?: number;
  /**
   * LAB-48 — when true, a candidate that LACKS audio features is compared on
   * genre dims only (`weightedCosine(.,.,0)`) instead of the LAB-36
   * plain-cosine-over-0.5-fills damping. The neutral 0.5 audio fills are a
   * constant, non-discriminating signal; under plain cosine they still
   * contributed mass and made null-audio tracks look audio-similar to
   * everything. Excluding the audio block reduces the metric to a pure genre
   * cosine for those candidates (populated candidates are unaffected). Optional:
   * legacy configs predate it and MUST replay byte-identically, so absence
   * means false — see {@link refillAudioCoverageGate}.
   */
  audioCoverageGate?: boolean;
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

/** Effective familiarity penalty for a refill config; legacy configs → 0 (no penalty). */
export function refillFamiliarityPenalty(config: RefillConfig): number {
  return config.familiarityPenalty ?? 0;
}

/**
 * LAB-48 — effective audio-coverage gate for a refill config; legacy configs →
 * false (the LAB-36 weight-1 damping). When true, a null-audio candidate is
 * compared on genre dims only — see {@link RefillConfig.audioCoverageGate}.
 */
export function refillAudioCoverageGate(config: RefillConfig): boolean {
  return config.audioCoverageGate ?? false;
}

/**
 * LAB-73 — the per-candidate refill penalty applied to a familiar artist at
 * novelty = 1.0. The novelty knob (`app_config.novelty`, [0,1]) scales it
 * down. Default novelty 0.5 ⇒ a 0.1 downweight on a refill score (keepSim ≈
 * 0.7–0.96): meaningful enough to let a novel-artist candidate outrank a
 * familiar one when the queue ceiling binds, but soft — it never excludes a
 * candidate from the pool (Constraint #4). Tunable in code (YAGNI to surface
 * as its own knob; novelty IS the operator-facing lever, Constraint #6).
 */
export const FAMILIARITY_PENALTY_AT_FULL_NOVELTY = 0.2;

/** Novelty-scaled effective familiarity penalty to freeze into a refill version. */
export function familiarityPenaltyFromNovelty(novelty: number): number {
  const n = Number.isFinite(novelty) ? Math.min(1, Math.max(0, novelty)) : 0.5;
  return n * FAMILIARITY_PENALTY_AT_FULL_NOVELTY;
}

/**
 * LAB-73 — normalized artist key for the diversity quota + familiarity
 * penalty. Mirrors the `trackKey` normalization in taste/import.ts
 * (lowercased, trimmed). Returns null for an absent/blank artist so such
 * candidates bypass both mechanisms rather than colliding on an empty key.
 */
export function artistKey(artist: string | null | undefined): string | null {
  if (!artist) return null;
  const key = artist.trim().toLowerCase();
  return key.length > 0 ? key : null;
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
  // LAB-73 — familiarityPenalty optional (legacy configs predate it → 0). When
  // present it's a score downweight in [0,1]: a negative would UP-weight
  // familiar artists (the opposite of the intent) and a >1 would dominate the
  // composite score, so reject both at the trust boundary.
  if (c.familiarityPenalty !== undefined) {
    if (!Number.isFinite(c.familiarityPenalty) || c.familiarityPenalty < 0) return false;
    if (c.familiarityPenalty > 1) return false;
  }
  // LAB-48 — audioCoverageGate optional (legacy configs predate it → false).
  // When present it must be a boolean; a non-boolean would silently decide the
  // null-audio comparison path and break replay determinism.
  if (c.audioCoverageGate !== undefined && typeof c.audioCoverageGate !== "boolean") {
    return false;
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
