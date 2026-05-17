import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { bucket, rating, surfaceEvent, track, trackSource } from "@/db/schema";
import type { RankerKind } from "@/lib/ranking/types";

/**
 * Read-only eval metrics. Pure DB → numbers; no mutation, no LLM.
 *
 * Why "compute on demand" rather than a daily_metrics table: at our scale
 * (single-user system, thousands of ratings at most) the queries are cheap,
 * and a denormalized table would just be one more thing to keep coherent
 * across schema changes. If volume ever justifies it, the contract here
 * doesn't change — only the implementation moves to a materialized view.
 *
 * Metrics surfaced:
 *   - keep-rate: how often the user kept what we surfaced, broken down by
 *     ranker (refill/broad), source, and model_version. Single number per
 *     dimension; the dashboard rolls these up over time.
 *   - precision-at-N: of the N highest-scoring candidates surfaced, what
 *     fraction were kept. Tracks "did the ranker put good things at the top."
 *   - bucket purity: per-bucket dislike rate (`dislike_count / member_count`).
 *     Drives the split heuristic and the Buckets-screen radar coloring.
 *   - genre entropy: shannon entropy over surfaced primary_genre distribution
 *     in a window. High entropy = broad coverage; low = "only rock all week."
 *     Acts as an early warning for the novelty knob being too low.
 *
 * All windows are inclusive on both ends. A null window-start means "all time
 * up to window-end". The default window-end is now.
 */

export type Window = {
  start?: Date | null;
  end?: Date;
};

export type KeepRateByDimension = {
  /** Total keep + dislike count (defer/neutral excluded — they're not signal). */
  decided: number;
  /** Of decided, how many were kept. */
  keeps: number;
  rate: number;
};

export type KeepRateBreakdown = {
  overall: KeepRateByDimension;
  byRanker: Record<RankerKind, KeepRateByDimension>;
  byModelVersion: Record<number, KeepRateByDimension>;
  bySource: Record<string, KeepRateByDimension>;
};

export async function keepRate(db: Database, window: Window = {}): Promise<KeepRateBreakdown> {
  // KPIs measure surfacing performance — exclude imported / manually-rated
  // tracks (surfaceEventId IS NULL) so the dashboard only credits ratings
  // that came from a surface event the ranker chose.
  const conditions = [...buildRatingWindowConditions(window), isNotNull(rating.surfaceEventId)];

  // Two queries on purpose: joining rating ↔ track_source expands a rating
  // row once per source the track was sighted in. The overall / ranker /
  // version dimensions need the rating counted exactly once; the source
  // dimension wants it credited to every source. Splitting keeps each
  // dimension's accounting honest without dedupe-set bookkeeping.
  const baseRows = await db
    .select({
      ratingId: rating.id,
      decision: rating.decision,
      modelVersionId: rating.modelVersionId,
      surfaceRanker: surfaceEvent.rankerKind,
    })
    .from(rating)
    .innerJoin(surfaceEvent, eq(surfaceEvent.id, rating.surfaceEventId))
    .where(and(...conditions));

  const sourceRows = await db
    .select({
      ratingId: rating.id,
      decision: rating.decision,
      source: trackSource.source,
    })
    .from(rating)
    .innerJoin(trackSource, eq(trackSource.trackId, rating.trackId))
    .where(and(...conditions));

  const overall = emptyDim();
  const byRanker: Record<RankerKind, KeepRateByDimension> = {
    refill: emptyDim(),
    broad: emptyDim(),
  };
  const byModelVersion: Record<number, KeepRateByDimension> = {};
  const bySource: Record<string, KeepRateByDimension> = {};

  for (const r of baseRows) {
    if (r.decision !== "keep" && r.decision !== "dislike") continue;
    const isKeep = r.decision === "keep";
    bumpDim(overall, isKeep);
    if (r.surfaceRanker) bumpDim(byRanker[r.surfaceRanker], isKeep);
    const v = byModelVersion[r.modelVersionId] ?? emptyDim();
    bumpDim(v, isKeep);
    byModelVersion[r.modelVersionId] = v;
  }

  // De-dupe by (ratingId, source) — a track_source row should only credit
  // its source once even if the join produced duplicates.
  const seenSourceKey = new Set<string>();
  for (const r of sourceRows) {
    if (r.decision !== "keep" && r.decision !== "dislike") continue;
    const key = `${r.ratingId}|${r.source}`;
    if (seenSourceKey.has(key)) continue;
    seenSourceKey.add(key);
    const s = bySource[r.source] ?? emptyDim();
    bumpDim(s, r.decision === "keep");
    bySource[r.source] = s;
  }

  return { overall, byRanker, byModelVersion, bySource };
}

export type PrecisionAtN = {
  n: number;
  surfacedCount: number;
  /** Surfaced events whose track was ultimately rated 'keep'. */
  keptCount: number;
  precision: number;
};

/**
 * P@N = of the top-N most recent surfaced events (within the window), what
 * fraction were kept. Defers and neutrals count as "not kept" — they're a
 * signal that the user wasn't sure, which is informative for the ranker.
 *
 * Top-N here means most recent — we're tracking how the ranker is performing
 * NOW, not historically. The Analyzer screen exposes a date filter.
 */
export async function precisionAtN(
  db: Database,
  n: number,
  window: Window = {},
): Promise<PrecisionAtN> {
  if (n <= 0) return { n, surfacedCount: 0, keptCount: 0, precision: 0 };
  const surfaceConditions = buildSurfaceWindowConditions(window);
  // Push ORDER BY + LIMIT into SQL — surface_event grows monotonically, so a
  // full-table fetch + JS sort would scale linearly with history.
  const top = await db
    .select({ id: surfaceEvent.id })
    .from(surfaceEvent)
    .where(surfaceConditions.length ? and(...surfaceConditions) : undefined)
    .orderBy(desc(surfaceEvent.surfacedAt), desc(surfaceEvent.id))
    .limit(n);
  if (top.length === 0) return { n, surfacedCount: 0, keptCount: 0, precision: 0 };

  const eventIds = top.map((e) => e.id);
  // Newest-first per (surfaceEventId, ratedAt) so that for events the user
  // re-rated (defer → keep, dislike → keep, etc.) the most recent decision
  // wins. inArray filters to just the top-N events instead of full-table.
  const ratedRows = await db
    .select({
      surfaceEventId: rating.surfaceEventId,
      decision: rating.decision,
      ratedAt: rating.ratedAt,
    })
    .from(rating)
    .where(inArray(rating.surfaceEventId, eventIds))
    .orderBy(desc(rating.ratedAt), desc(rating.id));
  const latestDecisionBySurfaceId = new Map<number, "keep" | "dislike" | "defer" | "neutral">();
  for (const r of ratedRows) {
    if (r.surfaceEventId === null) continue;
    if (latestDecisionBySurfaceId.has(r.surfaceEventId)) continue;
    latestDecisionBySurfaceId.set(r.surfaceEventId, r.decision);
  }
  const kept = eventIds.filter((id) => latestDecisionBySurfaceId.get(id) === "keep").length;
  return { n, surfacedCount: top.length, keptCount: kept, precision: kept / top.length };
}

export type BucketPurity = {
  bucketId: number;
  name: string;
  memberCount: number;
  dislikeCount: number;
  /** dislike_count / member_count; 0 when memberCount is 0. */
  dislikeRate: number;
  /** 1 − dislikeRate; clearer to read on the dashboard. */
  purity: number;
};

export async function bucketPurity(db: Database): Promise<BucketPurity[]> {
  const rows = await db
    .select({
      id: bucket.id,
      name: bucket.name,
      memberCount: bucket.memberCount,
      dislikeCount: bucket.dislikeCount,
    })
    .from(bucket);
  return rows.map((r) => {
    const rate = r.memberCount === 0 ? 0 : r.dislikeCount / r.memberCount;
    return {
      bucketId: r.id,
      name: r.name,
      memberCount: r.memberCount,
      dislikeCount: r.dislikeCount,
      dislikeRate: rate,
      purity: 1 - rate,
    };
  });
}

export type GenreEntropy = {
  /** Shannon entropy in nats (natural log). 0 = single genre, ln(k) = uniform across k genres. */
  entropy: number;
  /** Normalized to [0,1] by dividing by ln(distinctGenres) — comparable across windows. */
  normalized: number;
  distinctGenres: number;
  totalSurfaced: number;
};

/**
 * Genre entropy over the primary_genre distribution of tracks surfaced in
 * the window. Uses each track's `primary_genre` (one canonical slot per
 * track) — we want the user-facing label, not the multi-hot embedding dims.
 *
 * Tracks with null primary_genre are excluded from the distribution (they
 * couldn't be classified, so they don't contribute signal either way).
 */
export async function genreEntropy(db: Database, window: Window = {}): Promise<GenreEntropy> {
  const conditions = buildSurfaceWindowConditions(window);
  conditions.push(isNotNull(track.primaryGenre));
  const rows = await db
    .select({ genre: track.primaryGenre })
    .from(surfaceEvent)
    .innerJoin(track, eq(track.id, surfaceEvent.trackId))
    .where(and(...conditions));

  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.genre) continue;
    counts.set(r.genre, (counts.get(r.genre) ?? 0) + 1);
  }
  const total = rows.length;
  if (total === 0 || counts.size === 0) {
    return { entropy: 0, normalized: 0, distinctGenres: 0, totalSurfaced: 0 };
  }
  let h = 0;
  for (const c of counts.values()) {
    const p = c / total;
    if (p > 0) h -= p * Math.log(p);
  }
  const max = Math.log(counts.size);
  return {
    entropy: h,
    normalized: max === 0 ? 0 : h / max,
    distinctGenres: counts.size,
    totalSurfaced: total,
  };
}

export type AudioFeatureCoverage = {
  /** Total `track` rows. */
  total: number;
  /** Tracks with non-null `audio_features`. */
  withFeatures: number;
  /** withFeatures / total; 0 when there are no tracks. */
  coverage: number;
};

/**
 * Fraction of ingested tracks carrying audio features. Audio features now
 * come from ReccoBeats (Spotify retired `/audio-features`); coverage for
 * long-tail / indie tracks is uncharacterised, so this is the canary for
 * the audio half of the embedding silently going dark.
 */
export async function audioFeatureCoverage(db: Database): Promise<AudioFeatureCoverage> {
  // count(col) ignores nulls — `withFeatures` is exactly the non-null count.
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withFeatures: sql<number>`count(${track.audioFeatures})::int`,
    })
    .from(track);
  const total = row?.total ?? 0;
  const withFeatures = row?.withFeatures ?? 0;
  return { total, withFeatures, coverage: total === 0 ? 0 : withFeatures / total };
}

/**
 * Convenience aggregate for the Analyzer screen's "KPIs" panel — one round
 * trip pulling the top-line numbers.
 */
export type Kpis = {
  keepRate: KeepRateBreakdown;
  precisionAt10: PrecisionAtN;
  precisionAt25: PrecisionAtN;
  genreEntropy: GenreEntropy;
  bucketPurity: BucketPurity[];
  audioFeatureCoverage: AudioFeatureCoverage;
};

export async function loadKpis(db: Database, window: Window = {}): Promise<Kpis> {
  const [kr, p10, p25, ge, bp, afc] = await Promise.all([
    keepRate(db, window),
    precisionAtN(db, 10, window),
    precisionAtN(db, 25, window),
    genreEntropy(db, window),
    bucketPurity(db),
    audioFeatureCoverage(db),
  ]);
  return {
    keepRate: kr,
    precisionAt10: p10,
    precisionAt25: p25,
    genreEntropy: ge,
    bucketPurity: bp,
    audioFeatureCoverage: afc,
  };
}

function emptyDim(): KeepRateByDimension {
  return { decided: 0, keeps: 0, rate: 0 };
}

function bumpDim(dim: KeepRateByDimension, isKeep: boolean): void {
  dim.decided += 1;
  if (isKeep) dim.keeps += 1;
  dim.rate = dim.decided === 0 ? 0 : dim.keeps / dim.decided;
}

function buildRatingWindowConditions(window: Window) {
  const conds = [];
  if (window.start) conds.push(gte(rating.ratedAt, window.start));
  if (window.end) conds.push(lte(rating.ratedAt, window.end));
  return conds;
}

function buildSurfaceWindowConditions(window: Window) {
  const conds = [];
  if (window.start) conds.push(gte(surfaceEvent.surfacedAt, window.start));
  if (window.end) conds.push(lte(surfaceEvent.surfacedAt, window.end));
  return conds;
}
