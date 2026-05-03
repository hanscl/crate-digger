import { count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appConfig,
  bucket,
  bucketMember,
  rating,
  type SurfaceEvent,
  surfaceEvent,
  track,
} from "@/db/schema";
import { scoreBroadBatch } from "@/lib/ranking/broad";
import { scoreRefillBatch } from "@/lib/ranking/refill";
import type { Candidate, RatedTrack, RefillConfig, ScoredCandidate } from "@/lib/ranking/types";
import { configFromVersion, ensureActiveModelVersion } from "@/lib/ranking/version";
import { logSurfaceEvents } from "./log";

/**
 * Surfacing pipeline.
 *
 * Composition (applied in order):
 *
 *   1. Resolve effective caps. `effectiveCap = min(dailyCap, queueCeiling −
 *      queueDepth)`. Constraint #5: caps live HERE, not in ingestion. The
 *      candidate pool always carries everything ingest pulled.
 *   2. Resolve novelty mix. `novelty ∈ [0,1]` — 1 = pure broad (explore), 0 =
 *      pure refill (exploit). Refill quota = `round(cap · (1 − novelty))`,
 *      broad quota fills the rest. Quotas degrade automatically: if there
 *      are no refillable buckets (no keeps, no buckets) the refill quota
 *      reverts to broad.
 *   3. Refill phase. For each refill slot, pick a target bucket (round-robin
 *      across buckets with members), score every candidate against that
 *      bucket's keeps + global dislikes, surface the top unsurfaced
 *      candidate. Each surfaced winner is logged with the FULL candidate
 *      pool — Constraint #2.
 *   4. Broad phase. Score remaining candidates with the broad classifier.
 *      Take top-N. Same pool-logging contract.
 *   5. Source mix bookkeeping. The `app_config.source_mix` knob biases the
 *      broad-phase winner selection toward a target source ratio. Currently
 *      a soft preference (used as a tie-break and quota nudge); never a
 *      hard filter.
 *
 * Inputs are explicit: a candidate pool the caller produced (typically by
 * running ingestion). The pipeline does not reach back into ingestion.
 */

export type SurfacingParams = {
  /** Full ingested candidate set — Constraint #5: surfacing decides what reaches the user. */
  candidates: readonly Candidate[];
  /**
   * Optional overrides — primarily for tests. Production callers pass nothing
   * and inherit `app_config`.
   */
  noveltyOverride?: number;
  dailyCapOverride?: number;
  queueCeilingOverride?: number;
  /** When true, skip writing surface_event rows — useful for previews. Default false. */
  dryRun?: boolean;
};

export type SurfacingResult = {
  surfaced: ScoredCandidate[];
  events: SurfaceEvent[];
  refillPool: ScoredCandidate[];
  broadPool: ScoredCandidate[];
  refillModelVersionId: number;
  broadModelVersionId: number;
  appliedNovelty: number;
  effectiveCap: number;
  refillQuota: number;
  broadQuota: number;
  /** Bucket scopes that were refilled (one entry per refill event). */
  refilledBucketIds: number[];
};

export async function runSurfacingBatch(
  db: Database,
  params: SurfacingParams,
): Promise<SurfacingResult> {
  const { candidates, dryRun = false } = params;

  // Bootstrap: every surfacing run guarantees both rankers have an active
  // model_version row, so ratings collected against this run can attribute
  // to a real version. We derive each ranker's config DIRECTLY from the
  // version row we just got — issuing a fresh `getActiveConfig` lookup here
  // would race a concurrent `bumpModelVersion`, leading to events logged
  // with version N's id while candidates were scored with version N+1's
  // config. That divergence would silently break counterfactual replay.
  const refillVersion = await ensureActiveModelVersion(db, "refill");
  const broadVersion = await ensureActiveModelVersion(db, "broad");
  const refillConfig = configFromVersion(refillVersion, "refill");
  const broadConfig = configFromVersion(broadVersion, "broad");

  const cfg = await loadAppConfig(db);
  const novelty = clamp01(params.noveltyOverride ?? cfg.novelty);
  const dailyCap = params.dailyCapOverride ?? cfg.dailyCap;
  const queueCeiling = params.queueCeilingOverride ?? cfg.queueCeiling;

  const queueDepth = await unratedSurfacedCount(db);
  // dailyCap is a per-day budget, not per-batch — count what's already gone
  // out today and shrink the remaining cap. Without this, repeated
  // surfacing runs (cron + manual triggers) compound past `dailyCap`.
  const todaysCount = await todaysSurfacedCount(db);
  const remainingDailyCap = Math.max(0, dailyCap - todaysCount);
  const ceilingSlots = Math.max(0, queueCeiling - queueDepth);
  const effectiveCap = Math.max(0, Math.min(remainingDailyCap, ceilingSlots));

  // Quota split. Refill ratio = (1 − novelty); rounded so quotas sum to cap.
  const refillQuotaRaw = Math.round(effectiveCap * (1 - novelty));
  let refillQuota = Math.min(refillQuotaRaw, effectiveCap);
  let broadQuota = effectiveCap - refillQuota;

  // Load bucketing context. Buckets with at least one member are refillable.
  const refillableBuckets = await loadRefillableBuckets(db);
  const dislikes = await loadGlobalDislikes(db);

  if (refillableBuckets.length === 0 || candidates.length === 0) {
    // No refill possible → broad takes all available capacity.
    broadQuota += refillQuota;
    refillQuota = 0;
  }

  const refillResults = await runRefillPhase(db, {
    candidates,
    quota: refillQuota,
    buckets: refillableBuckets,
    dislikes,
    refillConfig,
    refillVersionId: refillVersion.id,
    dryRun,
  });

  // Refill can underdeliver — e.g., a target bucket has no embeddable members,
  // or the round-robin runs out of unique candidates. Roll any unfilled slots
  // forward into the broad quota so we still surface up to `effectiveCap`.
  const refillShortfall = Math.max(0, refillQuota - refillResults.surfaced.length);
  const effectiveBroadQuota = broadQuota + refillShortfall;

  // Broad phase scores ALL candidates (not just leftovers): Constraint #4 —
  // candidates rejected by refill stay in the broader pool with their broad
  // score. Soft penalties only.
  const broadPool = scoreBroadBatch(candidates, broadConfig);
  const alreadySurfacedIds = new Set(refillResults.surfaced.map((s) => s.candidate.trackId));
  const broadEligible = broadPool
    .filter((s) => !alreadySurfacedIds.has(s.candidate.trackId))
    .sort((a, b) => b.score - a.score || a.candidate.trackId - b.candidate.trackId);

  const broadWinners = pickWithSourceMix(broadEligible, effectiveBroadQuota, cfg.sourceMix);

  let broadEvents: SurfaceEvent[] = [];
  if (broadWinners.length > 0 && !dryRun) {
    broadEvents = await logSurfaceEvents(db, {
      pool: broadPool,
      winners: broadWinners,
      modelVersionId: broadVersion.id,
      bucketId: null,
    });
  }

  return {
    surfaced: [...refillResults.surfaced, ...broadWinners],
    events: [...refillResults.events, ...broadEvents],
    refillPool: refillResults.lastPool,
    broadPool,
    refillModelVersionId: refillVersion.id,
    broadModelVersionId: broadVersion.id,
    appliedNovelty: novelty,
    effectiveCap,
    refillQuota,
    broadQuota,
    refilledBucketIds: refillResults.refilledBucketIds,
  };
}

type RefillPhaseInput = {
  candidates: readonly Candidate[];
  quota: number;
  buckets: { id: number; memberTrackIds: readonly number[] }[];
  dislikes: readonly RatedTrack[];
  refillConfig: RefillConfig;
  refillVersionId: number;
  dryRun: boolean;
};

type RefillPhaseResult = {
  surfaced: ScoredCandidate[];
  events: SurfaceEvent[];
  refilledBucketIds: number[];
  /** Pool from the LAST refill iteration — useful for callers/tests inspecting the most recent run. */
  lastPool: ScoredCandidate[];
};

async function runRefillPhase(db: Database, input: RefillPhaseInput): Promise<RefillPhaseResult> {
  const { candidates, quota, buckets, dislikes, refillConfig, refillVersionId, dryRun } = input;
  const surfaced: ScoredCandidate[] = [];
  const events: SurfaceEvent[] = [];
  const refilledBucketIds: number[] = [];
  let lastPool: ScoredCandidate[] = [];

  if (quota === 0 || buckets.length === 0 || candidates.length === 0) {
    return { surfaced, events, refilledBucketIds, lastPool };
  }

  const surfacedIds = new Set<number>();
  // Round-robin across buckets, one slot per pass; exhausts after `quota` slots.
  for (let i = 0; i < quota; i++) {
    const targetBucket = buckets[i % buckets.length];
    if (!targetBucket) break;
    const keepEmbeddings = await loadKeepEmbeddingsForBucket(db, targetBucket.memberTrackIds);
    if (keepEmbeddings.length === 0) {
      // Nothing to anchor against — skip; broader caller fills the slot via broad.
      continue;
    }
    const pool = scoreRefillBatch(candidates, keepEmbeddings, dislikes, refillConfig);
    lastPool = pool;
    const eligible = pool
      .filter((s) => !surfacedIds.has(s.candidate.trackId))
      .sort((a, b) => b.score - a.score || a.candidate.trackId - b.candidate.trackId);
    const winner = eligible[0];
    if (!winner) break;

    surfaced.push(winner);
    surfacedIds.add(winner.candidate.trackId);
    refilledBucketIds.push(targetBucket.id);

    if (!dryRun) {
      const written = await logSurfaceEvents(db, {
        pool,
        winners: [winner],
        modelVersionId: refillVersionId,
        bucketId: targetBucket.id,
        surfacedReason: (w) =>
          `refill bucket ${targetBucket.id}: keep_sim=${w.subScores.keepSim?.toFixed(3) ?? "0.000"}`,
      });
      events.push(...written);
    }
  }

  return { surfaced, events, refilledBucketIds, lastPool };
}

/**
 * Source-mix-aware top-K selection. `sourceMix ∈ [0,1]` is the *target*
 * Spotify share — 0.5 = balanced. Greedy: walk the sorted list, prefer
 * source whose share is currently below target. When source is unknown
 * (Last.fm sightings without a `source` flag) the candidate competes purely
 * on score. Never a hard filter — Constraint #4.
 */
function pickWithSourceMix(
  scored: readonly ScoredCandidate[],
  quota: number,
  sourceMix: number,
): ScoredCandidate[] {
  if (quota <= 0) return [];
  if (scored.length <= quota) return [...scored];

  const target = clamp01(sourceMix);
  const winners: ScoredCandidate[] = [];
  const counts: Record<string, number> = {};
  let total = 0;

  // First pass: take strictly best by score, but allow at most `target * quota + 1`
  // from spotify and `(1 − target) * quota + 1` from KNOWN non-spotify before
  // deferring. Unknown-source candidates compete purely on score and don't
  // count against either quota — otherwise a flood of unknowns would lock out
  // legitimate non-spotify (e.g., Last.fm) picks.
  for (const c of scored) {
    if (winners.length >= quota) break;
    const src = c.candidate.source ?? "unknown";
    const isSpotify = src === "spotify";
    const isUnknown = src === "unknown";
    const allowedSpotify = Math.ceil(target * quota) + 1;
    const allowedOther = Math.ceil((1 - target) * quota) + 1;
    const spotifyCount = counts.spotify ?? 0;
    const unknownCount = counts.unknown ?? 0;
    const knownOtherCount = total - spotifyCount - unknownCount;
    if (isSpotify && spotifyCount >= allowedSpotify) continue;
    if (!isSpotify && !isUnknown && knownOtherCount >= allowedOther) continue;
    winners.push(c);
    counts[src] = (counts[src] ?? 0) + 1;
    total += 1;
  }
  // Second pass: top off if quotas left anything on the table.
  if (winners.length < quota) {
    const taken = new Set(winners.map((w) => w.candidate.trackId));
    for (const c of scored) {
      if (winners.length >= quota) break;
      if (taken.has(c.candidate.trackId)) continue;
      winners.push(c);
      taken.add(c.candidate.trackId);
    }
  }
  return winners;
}

type AppConfigSnapshot = {
  novelty: number;
  sourceMix: number;
  dailyCap: number;
  queueCeiling: number;
};

async function loadAppConfig(db: Database): Promise<AppConfigSnapshot> {
  const [row] = await db
    .select({
      novelty: appConfig.novelty,
      sourceMix: appConfig.sourceMix,
      dailyCap: appConfig.dailySurfaceCap,
      queueCeiling: appConfig.queueCeiling,
    })
    .from(appConfig)
    .limit(1);
  return {
    novelty: row?.novelty ?? 0.5,
    sourceMix: row?.sourceMix ?? 0.5,
    dailyCap: row?.dailyCap ?? 15,
    queueCeiling: row?.queueCeiling ?? 50,
  };
}

/**
 * Queue depth = surfaced events not yet rated by the user. The queue ceiling
 * keeps surfacing from running ahead of the user's review pace.
 */
async function unratedSurfacedCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(surfaceEvent)
    .leftJoin(rating, eq(rating.surfaceEventId, surfaceEvent.id))
    .where(isNull(rating.id));
  return Number(row?.n ?? 0);
}

/**
 * Count of surface_event rows since the start of today (server timezone).
 * Drives `remainingDailyCap` so the per-day budget holds across multiple
 * runs in a single day. Uses the `surface_event_surfaced_at_idx` for a
 * range scan.
 */
async function todaysSurfacedCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(surfaceEvent)
    .where(sql`${surfaceEvent.surfacedAt} >= DATE_TRUNC('day', NOW())`);
  return Number(row?.n ?? 0);
}

async function loadRefillableBuckets(
  db: Database,
): Promise<{ id: number; memberTrackIds: number[] }[]> {
  const rows = await db
    .select({
      id: bucket.id,
      trackId: bucketMember.trackId,
    })
    .from(bucket)
    .innerJoin(bucketMember, eq(bucketMember.bucketId, bucket.id));
  const grouped = new Map<number, number[]>();
  for (const r of rows) {
    const list = grouped.get(r.id) ?? [];
    list.push(r.trackId);
    grouped.set(r.id, list);
  }
  return [...grouped.entries()]
    .map(([id, memberTrackIds]) => ({ id, memberTrackIds }))
    .sort((a, b) => a.id - b.id);
}

async function loadGlobalDislikes(db: Database): Promise<RatedTrack[]> {
  const rows = await db
    .select({ trackId: track.id, embedding: track.embedding })
    .from(rating)
    .innerJoin(track, eq(track.id, rating.trackId))
    .where(eq(rating.decision, "dislike"));
  return rows
    .filter((r): r is { trackId: number; embedding: number[] } => r.embedding !== null)
    .map((r) => ({ trackId: r.trackId, embedding: r.embedding }));
}

/**
 * Bucket-anchor embeddings: bucket members are treated as the keep-set for
 * refill scoring. Cold-start seeds count as keeps (the user added them by
 * including them in the seed playlist). Once Phase 5 lands, we can scope
 * this further to "members with explicit keep ratings" without changing the
 * shape of this function — just narrow the SQL.
 */
async function loadKeepEmbeddingsForBucket(
  db: Database,
  memberTrackIds: readonly number[],
): Promise<RatedTrack[]> {
  if (memberTrackIds.length === 0) return [];
  const rows = await db
    .select({ trackId: track.id, embedding: track.embedding })
    .from(track)
    .where(inArray(track.id, memberTrackIds as number[]));
  return rows
    .filter((r): r is { trackId: number; embedding: number[] } => r.embedding !== null)
    .map((r) => ({ trackId: r.trackId, embedding: r.embedding }));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
