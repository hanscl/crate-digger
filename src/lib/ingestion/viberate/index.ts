/**
 * Viberate social-breakout discovery engine (LAB-90).
 *
 * Evolves the LAB-88 Spotify-trending adapter into a multi-feed breakout
 * engine. Goal: get out of the popular-playlist tail by sourcing a pool that
 * LEADS Spotify and composing the per-run pull toward tracks breaking out on
 * social/alternative signals while still small on Spotify.
 *
 *   Stage 1 (pool.ts)     pull YouTube-trending (DE/GB/US) + composite chart
 *                         (Shazam/SoundCloud) + Spotify-trending; dedup.
 *   Stage 2 (breakout.ts) score each row's breakout gap from FREE inline data,
 *                         select the top `limit` (pull composition, not a
 *                         surfacing filter — Constraint #5).
 *   Stage 2 (resolve.ts)  resolve only the shortlist to an ISRC (+ Spotify
 *                         maturity), then recompute the final breakout.
 *   Stage 3 (here)        emit RawCandidates; the breakout signal rides on
 *                         rawPayload (discovery signal only — never the taste
 *                         model). resolve.ts dedups by ISRC and stamps the
 *                         Spotify id; ReccoBeats + genre enrichers do the rest.
 *
 * Constraint #1: paid + OPTIONAL. Absent VIBERATE_API_KEY the adapter is
 * unavailable and the system runs on Spotify + Last.fm. Trending-only — the
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
import type { PooledRow, ViberateBreakout } from "./types";

/** Default chart territory for the Spotify feed (overridable via env). */
export const DEFAULT_TRENDING_COUNTRY = "US";

function trendingCountry(env: Env): string {
  return env.VIBERATE_TRENDING_COUNTRY.trim() || DEFAULT_TRENDING_COUNTRY;
}

/** Coerce the throttle limit to a positive integer in [1, MAX_RETURN]. */
function clampReturn(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_RETURN;
  return Math.max(1, Math.min(Math.floor(raw), MAX_RETURN));
}

function toCandidate(row: PooledRow, breakout: ViberateBreakout): RawCandidate {
  // sourceTrackId keys the track_source upsert, so it must be run-invariant.
  // YouTube rows gain a uuid only AFTER resolution succeeds, so key them on the
  // feed-native youtube_id (always present pre-resolution) to avoid a second
  // track_source row on a run where /by-channel failed. Composite uuid and the
  // Spotify id come straight off the feed row, so they're already stable.
  const stableId =
    row.feed === "youtube-trending" && row.youtubeId
      ? `yt:${row.youtubeId}`
      : (row.spotifyId ??
        (row.uuid && `vib:${row.uuid}`) ??
        row.isrc ??
        (row.youtubeId && `yt:${row.youtubeId}`) ??
        `${row.artist}::${row.title}`);
  return {
    source: "viberate",
    sourceTrackId: stableId,
    isrc: row.isrc,
    // Spotify-trending carries the Spotify id directly; for the other feeds it's
    // null and resolveSpotifyId backfills it from (artist, title) downstream.
    spotifyId: row.spotifyId,
    title: row.title,
    artist: row.artist,
    album: null,
    releaseYear: row.releaseYear,
    // No duration from any Viberate feed; ReccoBeats/Spotify fill it downstream.
    durationMs: null,
    genres: row.genres,
    rawPayload: { breakout, raw: row.raw },
  };
}

/** Pull the broad pool, score breakouts, select within budget, resolve, emit. */
async function runEngine(limit: number | undefined, env: Env): Promise<RawCandidate[]> {
  const want = clampReturn(limit);
  const pool = dedupePool(await gatherPool(env, trendingCountry(env)));
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

export const viberateAdapter: SourceAdapter = {
  id: "viberate",
  isPaid: true,
  isAvailable(env) {
    return env.VIBERATE_API_KEY.length > 0;
  },
  async pullCandidates(params, env) {
    // Guard BEFORE any network call so the no-credentials path never hits the
    // wire (and an empty Access-Key never leaves the process).
    if (env.VIBERATE_API_KEY.length === 0) return [];
    // Trending-only signal — similar/search don't map onto a chart and the
    // pipeline only calls trend adapters in `trending` mode anyway.
    if (params.mode !== "trending") return [];
    try {
      return await runEngine(params.limit, env);
    } catch (err) {
      console.error("[viberate] pullCandidates threw — degrading to []", err);
      return [];
    }
  },
};
