import { weightedCosine } from "@/lib/embedding";
import {
  artistKey,
  type Candidate,
  type RatedTrack,
  type RefillConfig,
  refillAudioCoverageGate,
  refillAudioWeight,
  refillFamiliarityPenalty,
  type ScoredCandidate,
} from "./types";

/**
 * Refill ranker (bucket-refill exploit mode).
 *
 *   score(c) = mean_i wcos(c, keep_i)  −  λ · mean_i wcos(c, dislike_i)
 *               −  familiarityPenalty · isFamiliar(artist(c))         [LAB-73]
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
 * - Null-audio coverage gate (LAB-48, was LAB-36 damping): a candidate whose
 *   audioFeatures are null (or absent) embeds neutral 0.5 audio fills — a
 *   constant, non-discriminating block. Under a gated version
 *   (`audioCoverageGate` true) its comparisons drop to audioWeight 0, excluding
 *   that block entirely so the metric reduces to a genre-only cosine; the 0.5
 *   fills can no longer make it look audio-similar to everything. Legacy/gate-
 *   off configs keep the LAB-36 weight-1 damping (plain cosine over the fills),
 *   so historical counterfactual replay stays byte-identical (Constraint #3).
 *   Populated candidates are unaffected either way (they use audioWeight).
 * - Familiarity penalty (LAB-73): refill keep-similarity rewards same-artist
 *   tracks (near-identical embeddings → top scores), so the queue fills with
 *   repeat artists. When `familiarArtists` contains the candidate's artist key
 *   and the version's `familiarityPenalty` is non-zero, that penalty is
 *   subtracted from the composite score — the SAME soft-downweight shape as the
 *   dislike term (Constraint #4: it only reorders, never drops a candidate from
 *   the pool, and it never touches keepSim so it can't move a candidate across
 *   the refill quality bar). The penalty is already novelty-scaled and frozen
 *   into the config (`familiarityPenaltyFromNovelty`), so replay stays
 *   config-deterministic. Absent/0 penalty → `score − 0 === score`, byte-
 *   identical to pre-LAB-73 scoring.
 *
 * Empty-input semantics:
 * - keeps empty → score = 0 (no positive signal yet; surfacing should fall back
 *   to broad mode in that case).
 * - dislikes empty → penalty term is 0. Score = mean keep similarity.
 *
 * Pure: no DB, no env, no globals. The stored `model_version.config` plus the
 * candidate/keep/dislike/familiar-artist inputs fully determine the output,
 * which is what makes counterfactual replay deterministic (`familiarArtists` is
 * reconstructed at replay time the same way keeps/dislikes are — accepted
 * drift).
 */
export function scoreRefill(
  candidate: Candidate,
  keeps: readonly RatedTrack[],
  dislikes: readonly RatedTrack[],
  config: RefillConfig,
  familiarArtists?: ReadonlySet<string>,
): ScoredCandidate {
  // LAB-48 — a null-audio candidate's 0.5 fills are routed through the SAME
  // weightedCosine path (via meanWeightedCosine) as everything else; an
  // audioWeight of 0 zeroes that block in the dot product and both norms,
  // yielding a genre-only cosine without a separate code path.
  const hasAudio = candidate.audioFeatures != null;
  const audioWeight = hasAudio
    ? refillAudioWeight(config)
    : refillAudioCoverageGate(config)
      ? 0 // LAB-48: genre-only cosine — exclude the absent track's audio block
      : 1; // legacy LAB-36 damping: plain cosine over the neutral 0.5 fills
  const keepSim = meanWeightedCosine(candidate.embedding, keeps, audioWeight);
  const dislikeSim = meanWeightedCosine(candidate.embedding, dislikes, audioWeight);
  const penaltyWeight = refillFamiliarityPenalty(config);
  const key = artistKey(candidate.artist);
  const familiarityPenalty =
    penaltyWeight > 0 && key !== null && (familiarArtists?.has(key) ?? false) ? penaltyWeight : 0;
  const score = keepSim - config.lambda * dislikeSim - familiarityPenalty;
  return {
    candidate,
    score,
    subScores: { keepSim, dislikeSim, lambda: config.lambda, familiarityPenalty },
    rankerKind: "refill",
  };
}

/** Score a list of candidates against the same keep/dislike/familiar-artist context. */
export function scoreRefillBatch(
  candidates: readonly Candidate[],
  keeps: readonly RatedTrack[],
  dislikes: readonly RatedTrack[],
  config: RefillConfig,
  familiarArtists?: ReadonlySet<string>,
): ScoredCandidate[] {
  return candidates.map((c) => scoreRefill(c, keeps, dislikes, config, familiarArtists));
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
