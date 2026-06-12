import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
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
  artistKey,
  type Candidate,
  type RatedTrack,
  type RefillConfig,
  refillFamiliarityPenalty,
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
 *   1. Eligibility gate (LAB-60, amended LAB-76). Drop candidates the user
 *      already decided (any keep/dislike/neutral rating, ever) and candidates
 *      already sitting unrated in the queue (a surface_event with no rating
 *      row). Re-pulls legitimately revisit tracks near bucket centroids;
 *      without this gate they would re-queue settled tracks or duplicate queue
 *      cards. Decision dedupe, not a taste penalty (Constraint #4 untouched);
 *      defer-only tracks stay eligible (defer means "later"). `neutral` settles
 *      the track (no re-surface) but carries zero taste signal.
 *   2. Resolve the queue-ceiling headroom. `effectiveCap = max(0, queueCeiling
 *      − unratedQueueDepth)`. This is the ONLY count bound — there is no
 *      per-day budget. The candidate pool always carries everything ingest
 *      pulled that is still undecided and not already queued unrated
 *      (Constraint #2, amended LAB-60).
 *   3. Refill phase. Score every candidate against each refillable bucket's
 *      keeps + global dislikes. Every on-genre candidate whose keep-similarity
 *      clears the refill bar (the spawn_threshold family) is a refill winner —
 *      dynamic count, possibly >1/bucket. Highest refill score first; bounded
 *      by `effectiveCap` when the ceiling binds. The refill score carries the
 *      LAB-73 familiarity penalty (already-kept artists rank lower). Each
 *      winner is logged with the FULL candidate pool — Constraint #2.
 *   4. Broad phase. Score remaining candidates with the broad classifier;
 *      every candidate whose P(keep) clears the broad bar (default 0.5) and
 *      isn't already a refill winner fills the remaining ceiling headroom,
 *      source-mix biased. Same pool-logging contract.
 *
 * LAB-73 — artist-diversity quota (lever 2). After both rankers pick their
 * above-bar winners, a per-artist cap (`surface_artist_cap`, default 1) is
 * enforced across the COMBINED surfaced set: at most N tracks per artist per
 * run reach the queue. Overflow stays enriched-but-unsurfaced — the same
 * defer-not-discard semantics as the LAB-53 quality bar, and still logged in
 * every `candidate_pool` (Constraint #2). Eligibility shaping, not a taste
 * penalty (Constraint #4 untouched); no model_version bump (LAB-60 precedent).
 *
 * Below-bar candidates are simply NOT surfaced (no `surface_event`). They stay
 * enriched + candidate-flagged (LAB-52); a re-pull dedupes to the existing row
 * and can surface in a future run if it clears the bar then. Novelty now scales
 * the refill familiarity penalty (LAB-73, frozen into the refill version) — it
 * no longer splits quotas (that job was removed in LAB-53).
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
  /**
   * LAB-73 — max surfaced tracks per artist per run (lever 2). Falls back to
   * app_config.surface_artist_cap (default 1). <= 0 disables the quota.
   */
  surfaceArtistCapOverride?: number;
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
  /**
   * LAB-73 — above-bar candidates the per-artist surfacing quota (lever 2) held
   * back this run: repeat-artist material suppressed across refill + broad.
   * Counted regardless of whether the queue ceiling would also have bound them
   * (it is the quota's footprint, not a ceiling metric). Constraint #2: these
   * stay scored in every event's candidate_pool, just not surfaced.
   */
  artistQuotaDeferredCount: number;
  /**
   * LAB-38 — the refill cursor AFTER this run (observability/testing). Refill
   * serves buckets in id order from the persisted `app_config.refill_cursor`
   * and advances it past the furthest bucket it reached (wrapping), so when the
   * queue ceiling binds, coverage rotates across all refillable buckets instead
   * of starving the same low-scoring/high-id ones. Equals the prior cursor when
   * refill surfaced nothing this run.
   */
  nextRefillCursor: number;
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
  // LAB-73 — per-artist surfacing quota (lever 2). <= 0 disables it.
  const surfaceArtistCap = params.surfaceArtistCapOverride ?? cfg.surfaceArtistCap;

  // LAB-53: the queue ceiling is the ONLY count bound — surfacing fills the
  // unrated queue up to the ceiling and stops. No per-day budget (that
  // abstraction was removed); cron/over-runs are bounded by the ceiling alone.
  const queueDepth = await unratedSurfacedCount(db);
  const effectiveCap = Math.max(0, queueCeiling - queueDepth);

  // Load bucketing context. Buckets with at least one member are refillable.
  const refillableBuckets = await loadRefillableBuckets(db);
  const dislikes = await loadGlobalDislikes(db);

  // LAB-73 — familiarity signal (lever 3). Only loaded when the refill version's
  // frozen penalty is non-zero, so legacy/penalty-0 installs pay no query and
  // stay byte-identical. Reconstructed the same way at replay time.
  const familiarArtists =
    refillFamiliarityPenalty(refillConfig) > 0 ? await loadFamiliarArtists(db) : undefined;

  // Refill phase: every on-genre candidate whose keep-similarity clears the
  // refill bar surfaces (dynamic count, possibly >1/bucket), highest refill
  // score first, bounded by the ceiling headroom and the per-artist quota.
  const refillResults = await runRefillPhase(db, {
    candidates,
    refillBar,
    cap: effectiveCap,
    artistCap: surfaceArtistCap,
    buckets: refillableBuckets,
    dislikes,
    familiarArtists,
    refillConfig,
    refillVersionId: refillVersion.id,
    // LAB-38 — where to START the ceiling-bound winner rotation this run.
    refillCursor: cfg.refillCursor,
    dryRun,
  });

  // LAB-73 — seed the cross-phase artist counts from the tracks refill ACTUALLY
  // surfaced (not the deduped-but-ceiling-cut ones), so broad can't push an
  // artist over the run-wide cap and a refill candidate that never surfaced
  // doesn't block a broad one.
  const artistCounts = new Map<string, number>();
  for (const s of refillResults.surfaced) {
    const key = artistKey(s.candidate.artist);
    if (key !== null) artistCounts.set(key, (artistCounts.get(key) ?? 0) + 1);
  }

  // Broad phase scores ALL candidates (Constraint #4 — refill-rejected
  // candidates stay in the pool with their broad score). Every candidate that
  // clears the broad bar and isn't already a refill winner fills the remaining
  // ceiling headroom, source-mix biased — after the per-artist quota dedups it.
  const remainingHeadroom = Math.max(0, effectiveCap - refillResults.surfaced.length);
  const broadPool = scoreBroadBatch(candidates, broadConfig);
  const alreadySurfacedIds = new Set(refillResults.surfaced.map((s) => s.candidate.trackId));
  const broadEligible = broadPool
    .filter((s) => !alreadySurfacedIds.has(s.candidate.trackId) && s.score >= broadBar)
    .sort((a, b) => b.score - a.score || a.candidate.trackId - b.candidate.trackId);

  // Dedupe to the per-artist cap (sharing `artistCounts` with refill) BEFORE
  // source-mix selection, so the cap holds across the COMBINED surfaced set and
  // source-mix can't reintroduce a same-artist track. Deferred = above-bar
  // broad candidates the quota suppressed.
  const { kept: broadArtistEligible, deferred: broadArtistDeferred } = dedupeByArtist(
    broadEligible,
    (s) => s.candidate.artist,
    artistCounts,
    surfaceArtistCap,
  );
  const broadWinners = pickWithSourceMix(broadArtistEligible, remainingHeadroom, cfg.sourceMix);

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
    artistQuotaDeferredCount: refillResults.artistQuotaDeferred + broadArtistDeferred,
    nextRefillCursor: refillResults.nextRefillCursor,
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
  /** LAB-73 — max refill winners per artist (lever 2). <= 0 disables the quota. */
  artistCap: number;
  buckets: {
    id: number;
    primaryGenre: string | null;
    centroid: number[];
    memberTrackIds: readonly number[];
  }[];
  dislikes: readonly RatedTrack[];
  /** LAB-73 — normalized artist keys whose tracks get the refill familiarity penalty (lever 3). */
  familiarArtists?: ReadonlySet<string>;
  refillConfig: RefillConfig;
  refillVersionId: number;
  /** LAB-38 — bucket-id the ceiling-bound winner rotation starts at this run. */
  refillCursor: number;
  dryRun: boolean;
};

type RefillPhaseResult = {
  surfaced: ScoredCandidate[];
  events: SurfaceEvent[];
  refilledBucketIds: number[];
  /** Pool from the LAST refill iteration — useful for callers/tests inspecting the most recent run. */
  lastPool: ScoredCandidate[];
  /** LAB-73 — above-bar refill winners the per-artist quota suppressed this run. */
  artistQuotaDeferred: number;
  /** LAB-38 — the cursor after this run (last bucket served + 1, wrapped); unchanged if nothing surfaced. */
  nextRefillCursor: number;
};

async function runRefillPhase(db: Database, input: RefillPhaseInput): Promise<RefillPhaseResult> {
  const {
    candidates,
    refillBar,
    cap,
    artistCap,
    buckets,
    dislikes,
    familiarArtists,
    refillConfig,
    refillVersionId,
    refillCursor,
    dryRun,
  } = input;
  const surfaced: ScoredCandidate[] = [];
  const events: SurfaceEvent[] = [];
  const refilledBucketIds: number[] = [];
  let lastPool: ScoredCandidate[] = [];

  if (cap <= 0 || buckets.length === 0 || candidates.length === 0) {
    return {
      surfaced,
      events,
      refilledBucketIds,
      lastPool,
      artistQuotaDeferred: 0,
      nextRefillCursor: refillCursor,
    };
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
    const pool = scoreRefillBatch(
      candidates,
      keepEmbeddings,
      dislikes,
      refillConfig,
      familiarArtists,
    );
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

  // LAB-38 — ROTATE the ceiling-bound winner selection across buckets instead
  // of letting a global score sort hand every ceiling slot to the same
  // high-scoring buckets every run (which starves the rest regardless of id).
  // Group winners by bucket (each group score-sorted), then walk the buckets in
  // id order STARTING at the persisted cursor (wrapping past the end). The
  // ceiling slice (below) therefore covers a different band of buckets each run;
  // when the ceiling has headroom every winner still surfaces (set unchanged).
  type Hit = { scored: ScoredCandidate; bucketId: number };
  const byBucket = new Map<number, Hit[]>();
  for (const hit of bestByTrack.values()) {
    const list = byBucket.get(hit.bucketId) ?? [];
    list.push(hit);
    byBucket.set(hit.bucketId, list);
  }
  for (const list of byBucket.values()) {
    // Within a bucket: highest refill score first (the familiarity penalty
    // already pushed already-kept artists down), trackId as the tiebreaker.
    list.sort(
      (a, b) =>
        b.scored.score - a.scored.score || a.scored.candidate.trackId - b.scored.candidate.trackId,
    );
  }
  const bucketIdsWithWinners = [...byBucket.keys()].sort((a, b) => a - b);
  const rotated = rotateFromCursor(bucketIdsWithWinners, refillCursor);
  const rotatedHits: Hit[] = [];
  for (const bucketId of rotated) {
    rotatedHits.push(...(byBucket.get(bucketId) ?? []));
  }

  // LAB-73 — apply the per-artist quota BEFORE the ceiling slice so distinct
  // artists backfill the cap (a local counts map; the caller re-derives the
  // cross-phase counts from the tracks actually surfaced). `artistQuotaDeferred`
  // counts every above-bar refill candidate the quota held back. Runs over the
  // rotation order so the quota and the rotation share one walk.
  const { kept, deferred: artistQuotaDeferred } = dedupeByArtist(
    rotatedHits,
    (hit) => hit.scored.candidate.artist,
    new Map<string, number>(),
    artistCap,
  );
  // `chosen` is a PREFIX of the rotation order, so its last element is the
  // furthest bucket the ceiling let us reach this run.
  const chosen = kept.slice(0, cap);

  // LAB-38 — advance the cursor past the last bucket served (wrapping). The next
  // run resumes from there, so coverage rotates over consecutive runs. When the
  // ceiling didn't bind, `chosen` already spans every winner bucket and the
  // cursor lands past the highest id (then wraps), which is the same set again.
  const nextRefillCursor =
    chosen.length > 0 ? chosen[chosen.length - 1]!.bucketId + 1 : refillCursor;

  // Group winners by bucket so each surface_event carries that bucket's FULL
  // candidate pool (Constraint #2). `logSurfaceEvents` writes one row per
  // winner with only that winner flagged surfaced. Grouping is order-independent,
  // so we group from `chosen` directly. The `surfaced` output array, however, is
  // iterated from a SCORE-DESC copy of `chosen` so it stays highest-score-first
  // (existing single-bucket / non-binding tests assert surfaced[0] is the top
  // scorer); the cursor above is computed from the ROTATION-ordered `chosen`.
  const surfacedOrder = [...chosen].sort(
    (a, b) =>
      b.scored.score - a.scored.score || a.scored.candidate.trackId - b.scored.candidate.trackId,
  );
  for (const hit of surfacedOrder) surfaced.push(hit.scored);

  const winnersByBucket = new Map<number, ScoredCandidate[]>();
  for (const hit of chosen) {
    const list = winnersByBucket.get(hit.bucketId) ?? [];
    list.push(hit.scored);
    winnersByBucket.set(hit.bucketId, list);
  }

  // LAB-38 — persist the advanced cursor so the rotation survives across runs.
  // The app_config id=1 row always exists here: ensureActiveModelVersion ran
  // earlier in runSurfacingBatch and lockAppConfig upserts it. Skip the write on
  // dryRun (previews never mutate state) and when the cursor didn't move.
  if (!dryRun && nextRefillCursor !== refillCursor) {
    await db
      .update(appConfig)
      .set({ refillCursor: nextRefillCursor, updatedAt: sql`NOW()` })
      .where(eq(appConfig.id, 1));
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

  return { surfaced, events, refilledBucketIds, lastPool, artistQuotaDeferred, nextRefillCursor };
}

/**
 * LAB-38 — rotate a sorted-ascending list of bucket ids so it STARTS at the
 * first id >= `cursor`, with the ids < `cursor` appended at the end (a wrap).
 * This is the order the ceiling-bound winner selection walks, so consecutive
 * runs cover different bands of buckets and no bucket starves. When no id
 * reaches the cursor (it ran past the highest id), the list is returned
 * unchanged — restarting at the lowest id, the natural wrap. Pure.
 */
function rotateFromCursor(ids: readonly number[], cursor: number): number[] {
  const start = ids.findIndex((id) => id >= cursor);
  if (start <= 0) return [...ids];
  return [...ids.slice(start), ...ids.slice(0, start)];
}

/**
 * LAB-73 — per-artist quota dedup (lever 2). Walks `items` in priority order
 * (caller pre-sorts by score) and keeps at most `cap` per normalized artist
 * key, mutating the shared `counts` map so the cap holds across phases
 * (refill → broad). Items with no artist key bypass the quota entirely (legacy
 * candidates without `artist`), and `cap <= 0` disables it. `deferred` counts
 * the items the quota dropped — the run's repeat-artist suppression footprint
 * (ceiling-independent; the caller separately bounds surfacing by the ceiling).
 */
function dedupeByArtist<T>(
  items: readonly T[],
  artistOf: (item: T) => string | null | undefined,
  counts: Map<string, number>,
  cap: number,
): { kept: T[]; deferred: number } {
  const kept: T[] = [];
  let deferred = 0;
  for (const item of items) {
    const key = artistKey(artistOf(item));
    if (key === null || cap <= 0) {
      kept.push(item);
      continue;
    }
    const used = counts.get(key) ?? 0;
    if (used >= cap) {
      deferred += 1;
      continue;
    }
    counts.set(key, used + 1);
    kept.push(item);
  }
  return { kept, deferred };
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
  surfaceArtistCap: number;
  /** LAB-38 — persisted rotating refill cursor (bucket-id the rotation resumes at). */
  refillCursor: number;
};

async function loadAppConfig(db: Database): Promise<AppConfigSnapshot> {
  const [row] = await db
    .select({
      novelty: appConfig.novelty,
      sourceMix: appConfig.sourceMix,
      queueCeiling: appConfig.queueCeiling,
      refillBar: appConfig.refillQualityBar,
      broadBar: appConfig.broadQualityBar,
      surfaceArtistCap: appConfig.surfaceArtistCap,
      refillCursor: appConfig.refillCursor,
    })
    .from(appConfig)
    .limit(1);
  return {
    novelty: row?.novelty ?? 0.5,
    sourceMix: row?.sourceMix ?? 0.5,
    queueCeiling: row?.queueCeiling ?? 50,
    refillBar: row?.refillBar ?? 0.7,
    broadBar: row?.broadBar ?? 0.5,
    surfaceArtistCap: row?.surfaceArtistCap ?? 1,
    refillCursor: row?.refillCursor ?? 0,
  };
}

/**
 * LAB-73 — the "familiar artist" set for the refill familiarity penalty
 * (lever 3): every artist the user has keep-rated (all-time) — the "we already
 * know their music, so more of it isn't discovery" signal. Keys are normalized
 * with `artistKey`.
 *
 * Keeps-ONLY by design. The "recently surfaced artist" signal the ticket also
 * mentions is deliberately left out HERE because this set feeds the VERSIONED,
 * replayed refill ranker: counterfactual replay must rebuild it the same way,
 * and the keep set is current state (the same accepted drift as the dislike
 * set) with no self-reference. A surface-event window would make an artist
 * "familiar" only via the very run/event being scored — penalized at replay
 * (the events exist) but NOT at live-score time (the set is loaded before this
 * run writes its events), silently depressing `agreementRate`. Cross-run
 * surfaced-repetition is instead handled deterministically and outside the
 * replayed ranker: the pull-side cap + familiar-keep skip (lever 1), the
 * per-run surfacing quota (lever 2), and the LAB-60 no-re-surface gate.
 *
 * Exported so `counterfactualReplay` reconstructs the EXACT same set (live and
 * replayed refill scores must agree given the same config — Constraint #2/#3).
 */
export async function loadFamiliarArtists(db: Database): Promise<Set<string>> {
  const keepRows = await db
    .selectDistinct({ artist: track.artist })
    .from(rating)
    .innerJoin(track, eq(track.id, rating.trackId))
    .where(eq(rating.decision, "keep"));
  const out = new Set<string>();
  for (const r of keepRows) {
    const key = artistKey(r.artist);
    if (key !== null) out.add(key);
  }
  return out;
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
 *   - `decided`: it carries ANY keep/dislike/neutral rating, ever — regardless
 *     of the rating's model_version or a later defer. The user already decided
 *     this track; re-surfacing would re-queue it as a fresh card. `neutral`
 *     (LAB-76) is "seen it, indifferent — never re-surface, zero taste signal":
 *     it settles the track here like keep/dislike, but contributes no signal to
 *     the taste model (no bucket commit, no dislike counter, no λ-penalty).
 *   - `pending`: it already has an unrated surface_event — it IS a queue card
 *     right now; surfacing it again would duplicate the card.
 *
 * This is an eligibility gate (a decision dedupe), NOT a taste penalty —
 * Constraint #4 is untouched: dislikes keep downweighting OTHER candidates
 * via the refill dislike term, never excluding them. Tracks whose only rating
 * is defer stay eligible — defer means "later", so they re-surface on
 * subsequent runs.
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
    .where(
      and(inArray(rating.trackId, ids), inArray(rating.decision, ["keep", "dislike", "neutral"])),
    );
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
