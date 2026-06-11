import { weightedCosine } from "@/lib/embedding";
import {
  type Candidate,
  type RatedTrack,
  type RefillConfig,
  refillAudioWeight,
  type ScoredCandidate,
} from "./types";

/**
 * Refill ranker (bucket-refill exploit mode).
 *
 *   score(c) = mean_i wcos(c, keep_i)  −  λ · mean_i wcos(c, dislike_i)
 *
 * where wcos is `weightedCosine` at the config's audioWeight (LAB-36) — the
 * SAME metric the bucket JOIN gate uses, so membership and surfacing stay one
 * metric family (Constraint #5 coherence). Legacy `{lambda}`-only configs
 * have no audioWeight → weight 1 → plain cosine, byte-identical to pre-LAB-36
 * scoring, which keeps historical counterfactual replays exact.
 *
 * - "keeps" are the embeddings of tracks that anchor the bucket being refilled
 *   (members + any explicit keep ratings in scope). Surfacing builds this set;
 *   the ranker stays pure.
 * - "dislikes" act as a soft repellent. Constraint #4 forbids hard filters,
 *   so the ranker NEVER drops candidates from the pool — it only lowers their
 *   scores. λ is the penalty weight (0..1ish), pulled from `app_config.refillLambda`
 *   and frozen into the active `model_version.config`.
 * - Null-audio damping (LAB-36): a candidate whose audioFeatures are null
 *   (or absent) embeds neutral 0.5 audio fills; up-weighting those would make
 *   it similar to everything. Its comparisons degrade to weight 1 — the same
 *   rule the JOIN gate applies in assign.ts.
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
  const audioWeight = candidate.audioFeatures ? refillAudioWeight(config) : 1;
  const keepSim = meanWeightedCosine(candidate.embedding, keeps, audioWeight);
  const dislikeSim = meanWeightedCosine(candidate.embedding, dislikes, audioWeight);
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

function meanWeightedCosine(
  target: readonly number[],
  anchors: readonly RatedTrack[],
  audioWeight: number,
): number {
  if (anchors.length === 0) return 0;
  let sum = 0;
  for (const a of anchors) sum += weightedCosine(target, a.embedding, audioWeight);
  return sum / anchors.length;
}
