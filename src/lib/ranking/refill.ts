import { cosine } from "@/lib/embedding";
import type { Candidate, RatedTrack, RefillConfig, ScoredCandidate } from "./types";

/**
 * Refill ranker (bucket-refill exploit mode).
 *
 *   score(c) = mean_i cosine(c, keep_i)  −  λ · mean_i cosine(c, dislike_i)
 *
 * - "keeps" are the embeddings of tracks that anchor the bucket being refilled
 *   (members + any explicit keep ratings in scope). Surfacing builds this set;
 *   the ranker stays pure.
 * - "dislikes" act as a soft repellent. Constraint #4 forbids hard filters,
 *   so the ranker NEVER drops candidates from the pool — it only lowers their
 *   scores. λ is the penalty weight (0..1ish), pulled from `app_config.refillLambda`
 *   and frozen into the active `model_version.config`.
 *
 * Empty-input semantics:
 * - keeps empty → score = 0 (no positive signal yet; surfacing should fall back
 *   to broad mode in that case).
 * - dislikes empty → penalty term is 0. Score = mean keep similarity.
 *
 * Pure: no DB, no env, no globals. The stored `model_version.config` plus the
 * candidate/keep/dislike inputs fully determine the output, which is what makes
 * counterfactual replay deterministic.
 */
export function scoreRefill(
  candidate: Candidate,
  keeps: readonly RatedTrack[],
  dislikes: readonly RatedTrack[],
  config: RefillConfig,
): ScoredCandidate {
  const keepSim = meanCosine(candidate.embedding, keeps);
  const dislikeSim = meanCosine(candidate.embedding, dislikes);
  const score = keepSim - config.lambda * dislikeSim;
  return {
    candidate,
    score,
    subScores: { keepSim, dislikeSim, lambda: config.lambda },
    rankerKind: "refill",
  };
}

/** Score a list of candidates against the same keep/dislike context. */
export function scoreRefillBatch(
  candidates: readonly Candidate[],
  keeps: readonly RatedTrack[],
  dislikes: readonly RatedTrack[],
  config: RefillConfig,
): ScoredCandidate[] {
  return candidates.map((c) => scoreRefill(c, keeps, dislikes, config));
}

function meanCosine(target: readonly number[], anchors: readonly RatedTrack[]): number {
  if (anchors.length === 0) return 0;
  let sum = 0;
  for (const a of anchors) sum += cosine(target, a.embedding);
  return sum / anchors.length;
}
