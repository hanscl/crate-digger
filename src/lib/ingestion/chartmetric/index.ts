/**
 * Chartmetric social-breakout discovery engine (LAB-117).
 *
 * The ChartMetric-powered sibling of the Viberate breakout engine (LAB-90), run
 * head-to-head so QA + ratings (per-source keep-rate via `evals/metrics.ts`)
 * decide which surfaces better discoveries. Same shape:
 *
 *   Stage 1 (pool.ts)     pull Shazam + SoundCloud + TikTok (social) + Spotify
 *                         regional (maturity) charts; dedup. ISRC + cm_track ride
 *                         inline, so no resolution hop is needed to dedup.
 *   Stage 2 (breakout.ts) score each row's breakout gap from the FREE inline
 *                         signals (social counts + `spotify_popularity`); select
 *                         the top `limit` (pull composition — Constraint #5).
 *   Stage 2 (resolve.ts)  upgrade the shortlist's maturity to continuous
 *                         (`cm_statistics`: playlist reach + streams), recompute.
 *   Stage 3 (here)        emit RawCandidates; the breakout signal rides on
 *                         rawPayload (discovery signal only — never the taste
 *                         model). Downstream dedups by ISRC + backfills Spotify.
 *
 * Constraint #1: paid + OPTIONAL. Absent CHARTMETRIC_REFRESH_TOKEN the adapter
 * is unavailable and the system runs on Spotify + Last.fm. Trending-only — the
 * daily pipeline only calls trend adapters in `trending` mode; similar/search
 * degrade to []. Never throws.
 */

import type { Env } from "@/server/env";
import type { SourceAdapter } from "../adapter";
import type { RawCandidate } from "../types";
import { selectTop, toBreakout } from "./breakout";
import { DEFAULT_RETURN, MAX_RETURN } from "./config";
import { dedupePool, gatherPool } from "./pool";
import { resolveRow } from "./resolve";
import type { ChartmetricBreakout, PooledRow } from "./types";

/** Default chart territory (overridable via env). */
export const DEFAULT_TRENDING_COUNTRY = "US";

function trendingCountry(env: Env): string {
  return env.CHARTMETRIC_TRENDING_COUNTRY.trim() || DEFAULT_TRENDING_COUNTRY;
}

/** Coerce the throttle limit to a positive integer in [1, MAX_RETURN]. */
function clampReturn(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_RETURN;
  return Math.max(1, Math.min(Math.floor(raw), MAX_RETURN));
}

function toCandidate(row: PooledRow, breakout: ChartmetricBreakout): RawCandidate {
  // sourceTrackId keys the track_source upsert, so it must be run-invariant. The
  // Chartmetric track id is present on every chart row and stable — prefer it.
  const stableId =
    (row.cmTrack && `cm:${row.cmTrack}`) ??
    row.isrc ??
    (row.spotifyId && `spotify:${row.spotifyId}`) ??
    `${row.artist}::${row.title}`;
  return {
    source: "chartmetric",
    sourceTrackId: stableId,
    isrc: row.isrc,
    spotifyId: row.spotifyId,
    title: row.title,
    artist: row.artist,
    album: null,
    releaseYear: row.releaseYear,
    // No duration from any chart feed; ReccoBeats/Spotify fill it downstream.
    durationMs: null,
    genres: row.genres,
    rawPayload: { breakout, raw: row.raw },
  };
}

/** Pull the broad pool, score breakouts, select within budget, resolve, emit. */
async function runEngine(limit: number | undefined, env: Env): Promise<RawCandidate[]> {
  const want = clampReturn(limit);
  const pool = dedupePool(await gatherPool(env, trendingCountry(env), new Date()));
  if (pool.length === 0) return [];

  // Preliminary breakout from FREE inline signals → compose the pull.
  const scored = pool.map((row) => ({ row, breakout: toBreakout(row.signals, row.feed) }));
  const shortlist = selectTop(scored, want);

  // Resolve only the shortlist (budgeted calls), then recompute the final score.
  const out: RawCandidate[] = [];
  for (const { row } of shortlist) {
    const resolved = await resolveRow(row, env);
    out.push(toCandidate(resolved, toBreakout(resolved.signals, resolved.feed)));
  }
  return out;
}

export const chartmetricAdapter: SourceAdapter = {
  id: "chartmetric",
  isPaid: true,
  isAvailable(env) {
    return env.CHARTMETRIC_REFRESH_TOKEN.length > 0;
  },
  async pullCandidates(params, env) {
    // Guard BEFORE any network call so the no-credentials path never hits the
    // wire (and no empty refresh token is ever exchanged).
    if (env.CHARTMETRIC_REFRESH_TOKEN.length === 0) return [];
    // Trending-only signal — similar/search don't map onto a chart and the
    // pipeline only calls trend adapters in `trending` mode anyway.
    if (params.mode !== "trending") return [];
    try {
      return await runEngine(params.limit, env);
    } catch (err) {
      console.error("[chartmetric] pullCandidates threw — degrading to []", err);
      return [];
    }
  },
};
