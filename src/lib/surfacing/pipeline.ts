import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appConfig,
  bucket,
  bucketMember,
  KEEP_ANCHOR_ORIGINS,
  rating,
  type SurfaceEvent,
  surfaceEvent,
  track,
} from "@/db/schema";
import { genreScopeCompatible } from "@/lib/bucketing/genre-scope";
import { scoreBroadBatch } from "@/lib/ranking/broad";
import { scoreRefillBatch } from "@/lib/ranking/refill";
import {
  type Candidate,
  type RatedTrack,
  type RefillConfig,
  refillGenreGate,
  type ScoredCandidate,
} from "@/lib/ranking/types";
import { configFromVersion, ensureActiveModelVersion } from "@/lib/ranking/version";
import { logSurfaceEvents } from "./log";

/**
 * Surfacing pipeline.
 *
 * LAB-53 — quality-gated surfacing. Constraint #5 changed from "daily cap +
 * queue ceiling" to "pull throttle + quality bar + queue ceiling": the per-run
 * pull size (LAB-51) decides how much to ingest, a per-ranker quality bar
 * decides what clears, and the queue ceiling is the only hard count bound.
 *
 * Composition (applied in order):
 *
 *   1. Eligibility gate (LAB-60). Drop candidates the user already decided
 *      (any keep/dislike rating, ever) and candidates already sitting unrated
 *      in the queue (a surface_event with no rating row). Re-pulls
 *      legitimately revisit tracks near bucket centroids; without this gate
 *      they would re-queue settled tracks or duplicate queue cards. Decision
 *      dedupe, not a taste penalty (Constraint #4 untouched); defer/neutral-
 *      only tracks stay eligible.
 *   2. Resolve the queue-ceiling headroom. `effectiveCap = max(0, queueCeiling
 *      − unratedQueueDepth)`. This is the ONLY count bound — there is no
 *      per-day budget. The candidate pool always carries everything ingest
 *      pulled that is still undecided and not already queued unrated
 *      (Constraint #2, amended LAB-60).
 *   3. Refill phase. Score every candidate against each refillable bucket's
 *      keeps + global dislikes. Every on-genre candidate whose keep-similarity
 *      clears the refill bar (the spawn_threshold family) is a refill winner —
 *      dynamic count, possibly >1/bucket. Highest refill score first; bounded
 *      by `effectiveCap` when the ceiling binds. Each winner is logged with the
 *      FULL candidate pool — Constraint #2.
 *   4. Broad phase. Score remaining candidates with the broad classifier;
 *      every candidate whose P(keep) clears the broad bar (default 0.5) and
 *      isn't already a refill winner fills the remaining ceiling headroom,
 *      source-mix biased. Same pool-logging contract.
 *
 * Below-bar candidates are simply NOT surfaced (no `surface_event`). They stay
 * enriched + candidate-flagged (LAB-52); a re-pull dedupes to the existing row
 * and can surface in a future run if it clears the bar then. Novelty no longer
 * splits quotas (LAB-42 will repurpose it to bias the pull mix / bars).
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
  queueCeilingOverride?: number;
  /** Refill keep-similarity bar (LAB-53). Falls back to app_config.refill_quality_bar. */
  refillBarOverride?: number;
  /** Broad classifier-probability bar (LAB-53). Falls back to app_config.broad_quality_bar. */
  broadBarOverride?: number;
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
  /** Queue-ceiling headroom = max(0, queueCeiling − unrated). The only count bound. */
  effectiveCap: number;
  /** How many above-bar candidates each ranker actually surfaced this run. */
  refillSurfacedCount: number;
  broadSurfacedCount: number;
  /** The applied quality bars (observability). */
  refillBar: number;
  broadBar: number;
  /** Bucket scopes that were refilled (one entry per refilled bucket). */
  refilledBucketIds: number[];
  /** LAB-60 — candidates dropped at entry: the user already keep/dislike-decided them. */
  excludedDecidedCount: number;
  /** LAB-60 — candidates dropped at entry: an unrated surface_event already queues them. */
  excludedPendingCount: number;
};

export async function runSurfacingBatch(
  db: Database,
  params: SurfacingParams,
): Promise<SurfacingResult> {
  const { dryRun = false } = params;

  // LAB-60 — eligibility gate, applied before ANY scoring so the refill pool,
  // broad pool, candidate_pool logging, quality bars, and dryRun previews all
  // see only the eligible set.
  const ineligible = await loadIneligibleTrackIds(
    db,
    params.candidates.map((c) => c.trackId),
  );
  const candidates: Candidate[] = [];
  let excludedDecidedCount = 0;
  let excludedPendingCount = 0;
  for (const c of params.candidates) {
    if (ineligible.decided.has(c.trackId)) excludedDecidedCount += 1;
    else if (ineligible.pending.has(c.trackId)) excludedPendingCount += 1;
    else candidates.push(c);
  }

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
  const queueCeiling = params.queueCeilingOverride ?? cfg.queueCeiling;
  const refillBar = clamp01(params.refillBarOverride ?? cfg.refillBar);
  const broadBar = clamp01(params.broadBarOverride ?? cfg.broadBar);

  // LAB-53: the queue ceiling is the ONLY count bound — surfacing fills the
  // unrated queue up to the ceiling and stops. No per-day budget (that
  // abstraction was removed); cron/over-runs are bounded by the ceiling alone.
  const queueDepth = await unratedSurfacedCount(db);
  const effectiveCap = Math.max(0, queueCeiling - queueDepth);

  // Load bucketing context. Buckets with at least one member are refillable.
  const refillableBuckets = await loadRefillableBuckets(db);
  const dislikes = await loadGlobalDislikes(db);

  // Refill phase: every on-genre candidate whose keep-similarity clears the
  // refill bar surfaces (dynamic count, possibly >1/bucket), highest refill
  // score first, bounded by the ceiling headroom.
  const refillResults = await runRefillPhase(db, {
    candidates,
    refillBar,
    cap: effectiveCap,
    buckets: refillableBuckets,
    dislikes,
    refillConfig,
    refillVersionId: refillVersion.id,
    dryRun,
  });

  // Broad phase scores ALL candidates (Constraint #4 — refill-rejected
  // candidates stay in the pool with their broad score). Every candidate that
  // clears the broad bar and isn't already a refill winner fills the remaining
  // ceiling headroom, source-mix biased.
  const remainingHeadroom = Math.max(0, effectiveCap - refillResults.surfaced.length);
  const broadPool = scoreBroadBatch(candidates, broadConfig);
  const alreadySurfacedIds = new Set(refillResults.surfaced.map((s) => s.candidate.trackId));
  const broadEligible = broadPool
    .filter((s) => !alreadySurfacedIds.has(s.candidate.trackId) && s.score >= broadBar)
    .sort((a, b) => b.score - a.score || a.candidate.trackId - b.candidate.trackId);

  const broadWinners = pickWithSourceMix(broadEligible, remainingHeadroom, cfg.sourceMix);

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
    refillSurfacedCount: refillResults.surfaced.length,
    broadSurfacedCount: broadWinners.length,
    refillBar,
    broadBar,
    refilledBucketIds: refillResults.refilledBucketIds,
    excludedDecidedCount,
    excludedPendingCount,
  };
}

type RefillPhaseInput = {
  // Invariant for the winner-eligibility gate: each candidate MUST carry the
  // persisted `track.primary_genre` (plus its embedding, always present on a
  // Candidate) so `genreScopeCompatible` can compare it to the bucket's
  // genre scope. An absent/undefined primaryGenre is coerced to null.
  // Satisfied today by `loadCandidates`, which projects `track.primary_genre`
  // onto each Candidate.
  candidates: readonly Candidate[];
  refillBar: number;
  cap: number;
  buckets: {
    id: number;
    primaryGenre: string | null;
    centroid: number[];
    memberTrackIds: readonly number[];
  }[];
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
  const { candidates, refillBar, cap, buckets, dislikes, refillConfig, refillVersionId, dryRun } =
    input;
  const surfaced: ScoredCandidate[] = [];
  const events: SurfaceEvent[] = [];
  const refilledBucketIds: number[] = [];
  let lastPool: ScoredCandidate[] = [];

  if (cap <= 0 || buckets.length === 0 || candidates.length === 0) {
    return { surfaced, events, refilledBucketIds, lastPool };
  }

  // Score every candidate against every refillable bucket. A candidate is a
  // refill winner for a bucket when its keep-similarity clears the refill bar
  // (the spawn_threshold family) AND it passes the genre gate the SCORING
  // VERSION's config selects (LAB-36: 'slot-overlap'; legacy versions:
  // 'exact' — mirroring the JOIN gate in assign.ts so membership and
  // surfacing share one rule). Gate-incompatible / below-bar candidates stay
  // scored in the pool (Constraint #2) but never win. A candidate eligible
  // for several buckets is assigned to the bucket where its refill score
  // (keep_sim − λ·dislike_sim) is highest.
  const genreGate = refillGenreGate(refillConfig);
  const bestByTrack = new Map<number, { scored: ScoredCandidate; bucketId: number }>();
  const poolByBucket = new Map<number, ScoredCandidate[]>();

  for (const targetBucket of buckets) {
    const keepEmbeddings = await loadKeepEmbeddingsForBucket(db, targetBucket.memberTrackIds);
    if (keepEmbeddings.length === 0) continue;
    const pool = scoreRefillBatch(candidates, keepEmbeddings, dislikes, refillConfig);
    poolByBucket.set(targetBucket.id, pool);
    lastPool = pool;
    for (const s of pool) {
      const keepSim = s.subScores.keepSim ?? 0;
      if (keepSim < refillBar) continue;
      if (
        !genreScopeCompatible(
          genreGate,
          { primaryGenre: s.candidate.primaryGenre, embedding: s.candidate.embedding },
          { primaryGenre: targetBucket.primaryGenre, centroid: targetBucket.centroid },
        )
      ) {
        continue;
      }
      const existing = bestByTrack.get(s.candidate.trackId);
      if (!existing || s.score > existing.scored.score) {
        bestByTrack.set(s.candidate.trackId, { scored: s, bucketId: targetBucket.id });
      }
    }
  }

  // Highest refill score first; the queue ceiling is the only count bound, so
  // ordering only matters when `cap` binds.
  const ranked = [...bestByTrack.values()].sort(
    (a, b) =>
      b.scored.score - a.scored.score || a.scored.candidate.trackId - b.scored.candidate.trackId,
  );
  const chosen = ranked.slice(0, cap);

  // Group winners by bucket so each surface_event carries that bucket's FULL
  // candidate pool (Constraint #2). `logSurfaceEvents` writes one row per
  // winner with only that winner flagged surfaced.
  const winnersByBucket = new Map<number, ScoredCandidate[]>();
  for (const hit of chosen) {
    surfaced.push(hit.scored);
    const list = winnersByBucket.get(hit.bucketId) ?? [];
    list.push(hit.scored);
    winnersByBucket.set(hit.bucketId, list);
  }

  for (const [bucketId, winners] of winnersByBucket) {
    refilledBucketIds.push(bucketId);
    if (!dryRun) {
      const pool = poolByBucket.get(bucketId) ?? winners;
      const written = await logSurfaceEvents(db, {
        pool,
        winners,
        modelVersionId: refillVersionId,
        bucketId,
        surfacedReason: (w) =>
          `refill bucket ${bucketId}: keep_sim=${w.subScores.keepSim?.toFixed(3) ?? "0.000"}`,
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
  queueCeiling: number;
  refillBar: number;
  broadBar: number;
};

async function loadAppConfig(db: Database): Promise<AppConfigSnapshot> {
  const [row] = await db
    .select({
      novelty: appConfig.novelty,
      sourceMix: appConfig.sourceMix,
      queueCeiling: appConfig.queueCeiling,
      refillBar: appConfig.refillQualityBar,
      broadBar: appConfig.broadQualityBar,
    })
    .from(appConfig)
    .limit(1);
  return {
    novelty: row?.novelty ?? 0.5,
    sourceMix: row?.sourceMix ?? 0.5,
    queueCeiling: row?.queueCeiling ?? 50,
    refillBar: row?.refillBar ?? 0.7,
    broadBar: row?.broadBar ?? 0.5,
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

async function loadRefillableBuckets(
  db: Database,
): Promise<
  { id: number; primaryGenre: string | null; centroid: number[]; memberTrackIds: number[] }[]
> {
  // LAB-61 — only keep-anchor origins count as the bucket's keep-set. Today
  // that is every origin (post-backfill, every member is a seed or a keep);
  // the explicit filter keeps a future non-anchor origin from silently
  // anchoring refill. Mirrored in the counterfactual replay's
  // loadKeepsByBucket so live and replayed keep-sets stay symmetric.
  // The centroid feeds the LAB-36 slot-overlap winner gate (bucket-side
  // genre mass).
  const rows = await db
    .select({
      id: bucket.id,
      primaryGenre: bucket.primaryGenre,
      centroid: bucket.centroid,
      trackId: bucketMember.trackId,
    })
    .from(bucket)
    .innerJoin(bucketMember, eq(bucketMember.bucketId, bucket.id))
    .where(inArray(bucketMember.origin, [...KEEP_ANCHOR_ORIGINS]));
  const grouped = new Map<
    number,
    { primaryGenre: string | null; centroid: number[]; memberTrackIds: number[] }
  >();
  for (const r of rows) {
    const entry = grouped.get(r.id) ?? {
      primaryGenre: r.primaryGenre,
      centroid: r.centroid,
      memberTrackIds: [],
    };
    entry.memberTrackIds.push(r.trackId);
    grouped.set(r.id, entry);
  }
  return [...grouped.entries()]
    .map(([id, v]) => ({
      id,
      primaryGenre: v.primaryGenre,
      centroid: v.centroid,
      memberTrackIds: v.memberTrackIds,
    }))
    .sort((a, b) => a.id - b.id);
}

/**
 * LAB-60 — surfacing-entry eligibility gate. A candidate is ineligible when:
 *
 *   - `decided`: it carries ANY keep/dislike rating, ever — regardless of the
 *     rating's model_version or a later defer. The user already decided this
 *     track; re-surfacing would re-queue it as a fresh card.
 *   - `pending`: it already has an unrated surface_event — it IS a queue card
 *     right now; surfacing it again would duplicate the card.
 *
 * This is an eligibility gate (a decision dedupe), NOT a taste penalty —
 * Constraint #4 is untouched: dislikes keep downweighting OTHER candidates
 * via the refill dislike term, never excluding them. Tracks whose only
 * ratings are defer/neutral stay eligible — defer means "later", so they
 * re-surface on subsequent runs.
 */
async function loadIneligibleTrackIds(
  db: Database,
  candidateTrackIds: readonly number[],
): Promise<{ decided: Set<number>; pending: Set<number> }> {
  if (candidateTrackIds.length === 0) {
    return { decided: new Set(), pending: new Set() };
  }
  const ids = candidateTrackIds as number[];
  const decidedRows = await db
    .selectDistinct({ trackId: rating.trackId })
    .from(rating)
    .where(and(inArray(rating.trackId, ids), inArray(rating.decision, ["keep", "dislike"])));
  const pendingRows = await db
    .selectDistinct({ trackId: surfaceEvent.trackId })
    .from(surfaceEvent)
    .leftJoin(rating, eq(rating.surfaceEventId, surfaceEvent.id))
    .where(and(inArray(surfaceEvent.trackId, ids), isNull(rating.id)));
  return {
    decided: new Set(decidedRows.map((r) => r.trackId)),
    pending: new Set(pendingRows.map((r) => r.trackId)),
  };
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
 * Bucket-anchor embeddings: bucket members are the keep-set for refill
 * scoring. LAB-61 guarantees every member is either a deliberate cold-start
 * seed (the user chose it for the seed playlist/paste — counts as a keep) or
 * a discovery track the user explicitly kept; legacy eager-joined members
 * with non-keep ratings were removed by the 0011 backfill and
 * `loadRefillableBuckets` filters on the keep-anchor origins. The caller
 * passes member ids already scoped that way — this function only hydrates
 * embeddings.
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
