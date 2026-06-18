import type { Database } from "@/db/client";
import {
  type AudioFeatures,
  type CandidatePoolEntry,
  type NewSurfaceEvent,
  type SurfaceEvent,
  surfaceEvent,
} from "@/db/schema";
import type { RankerKind, ScoredCandidate } from "@/lib/ranking/types";

/**
 * Constraint #2 (the eval substrate): every `surface_event` must record the
 * FULL ranking context — every candidate's score in the pool that produced
 * the surfaced winner, not just the winner. This is what enables
 * counterfactual replay. If this is broken, every downstream eval is silently
 * wrong. There is a guard test in `tests/surfacing/log.test.ts`.
 *
 * Each row's `candidate_pool` carries the same scored entries; the `surfaced`
 * flag is scoped to THAT row's winner only. So a single surface_event read in
 * isolation identifies its own winner without needing the rest of the batch.
 */

export type SurfaceLogInput = {
  /** The full scored pool. Every candidate appears here regardless of cap/quotas. */
  pool: readonly ScoredCandidate[];
  /** The candidates the pipeline chose to surface. Must be a subset of `pool`. */
  winners: readonly ScoredCandidate[];
  /** Pinned at the start of the surfacing run; same value used for every event. */
  modelVersionId: number;
  /** Optional bucket scope — refill events tag the bucket they refilled. */
  bucketId?: number | null;
  /** Per-winner explanation suffix: e.g., "refill: bucket #4 'Indie Rock'". */
  surfacedReason?: (winner: ScoredCandidate) => string | null;
};

/**
 * Persist one `surface_event` per winner. Each row's `candidate_pool` is the
 * FULL pool (winners + losers) with scores; the `surfaced` flag flips for the
 * row whose winner this event represents. This shape is what
 * `counterfactualReplay` reads back — a ranker re-run against
 * `candidate_pool` (using the row's `model_version_id`) must reproduce the
 * same ordering.
 */
export async function logSurfaceEvents(
  db: Database,
  input: SurfaceLogInput,
): Promise<SurfaceEvent[]> {
  const { pool, winners, modelVersionId, bucketId, surfacedReason } = input;
  if (winners.length === 0) return [];

  const poolIds = new Set(pool.map((s) => s.candidate.trackId));
  for (const w of winners) {
    if (!poolIds.has(w.candidate.trackId)) {
      // Catching this here rather than at insert-time: a winner that isn't in
      // the recorded pool means the eval substrate would be inconsistent.
      // Better to refuse to write than to write a corrupt snapshot.
      throw new Error(
        `logSurfaceEvents: winner trackId=${w.candidate.trackId} not present in pool`,
      );
    }
  }

  const rows: NewSurfaceEvent[] = winners.map((w) => {
    // One pool snapshot per event, with `surfaced` flagging only THIS event's
    // winner — every other entry (including other winners in the same batch)
    // is surfaced=false within this row's pool.
    const candidatePool: CandidatePoolEntry[] = pool.map((s) => ({
      trackId: s.candidate.trackId,
      score: s.score,
      subScores: s.subScores,
      surfaced: s.candidate.trackId === w.candidate.trackId,
      // LAB-92 — freeze the breakout score the broad ranker scored against, so
      // counterfactual replay reproduces the mainstream down-weight without
      // re-reading the mutable `raw_payload` (Constraint #3). Omitted (not
      // null) when the candidate carried no breakout reading, so legacy pool
      // rows and non-breakout candidates serialize identically.
      ...(typeof s.candidate.breakout === "number" ? { breakout: s.candidate.breakout } : {}),
    }));

    const features = w.candidate.audioFeatures ?? null;
    const row: NewSurfaceEvent = {
      trackId: w.candidate.trackId,
      rankerKind: w.rankerKind,
      bucketId: bucketId ?? null,
      modelVersionId,
      featuresAtDecision: featuresOrEmpty(features),
      winnerScore: w.score,
      candidatePool,
      surfacedReason: surfacedReason?.(w) ?? defaultReason(w),
    };
    return row;
  });

  const inserted = await db.insert(surfaceEvent).values(rows).returning();
  return inserted;
}

function defaultReason(w: ScoredCandidate): string {
  if (w.rankerKind === "refill") {
    const keep = w.subScores.keepSim?.toFixed(3) ?? "0.000";
    const dis = w.subScores.dislikeSim?.toFixed(3) ?? "0.000";
    return `refill: keep_sim=${keep}, dislike_sim=${dis}`;
  }
  const logit = w.subScores.logit?.toFixed(3) ?? "0.000";
  return `broad: P(keep)=${w.score.toFixed(3)}, logit=${logit}`;
}

function featuresOrEmpty(features: AudioFeatures | null): AudioFeatures {
  // surface_event.features_at_decision is NOT NULL; persist a neutral row
  // when audio features are missing rather than synthesizing fake data.
  if (features) return features;
  return {
    tempo: 0,
    energy: 0,
    valence: 0,
    danceability: 0,
    acousticness: 0,
    instrumentalness: 0,
  };
}

/** Cast helper for callers. surface_event.ranker_kind is enum-typed. */
export function isRankerKind(s: string): s is RankerKind {
  return s === "refill" || s === "broad";
}
