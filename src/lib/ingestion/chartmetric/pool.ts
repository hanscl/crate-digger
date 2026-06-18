/**
 * Stage 1 — the broad pool (LAB-117). Pulls the lead-Spotify chart feeds, maps
 * each row into a common `PooledRow` (extracting whatever breakout signals are
 * inline and free — ISRC, cm_track, social counts, and `spotify_popularity` all
 * ride on the row), and dedups the union. No resolution and no scoring happen
 * here — those are Stages 2/3.
 */

import type { Env } from "@/server/env";
import { num } from "./breakout";
import { getChart } from "./client";
import { FEEDS } from "./config";
import type { BreakoutSignals, ChartRow, ChartmetricFeed, PooledRow } from "./types";
import {
  artistTitleKey,
  extractArtist,
  extractTitle,
  normalizeIsrc,
  parseReleaseYear,
  str,
} from "./util";

/** A row is unusable if it has no title, or nothing to resolve/dedup on. */
function isResolvable(row: PooledRow): boolean {
  if (row.title.length === 0) return false;
  return Boolean(row.isrc || row.cmTrack || row.spotifyId || row.artist.length > 0);
}

/** Per-feed signal extraction — each chart populates a different momentum field. */
function feedSignals(feedId: ChartmetricFeed["id"], e: ChartRow): BreakoutSignals {
  const spotifyPopularity = num(e.spotify_popularity);
  const chartVelocity = num(e.velocity);
  switch (feedId) {
    case "shazam":
      return { shazamCount: num(e.num_of_shazams), chartVelocity, spotifyPopularity };
    case "tiktok":
      return { tiktokPosts: num(e.weekly_posts), chartVelocity, spotifyPopularity };
    case "soundcloud":
      // SoundCloud's per-row play count field wasn't observed in the spike; the
      // `trending` chart still scores on velocity + popularity. `num` no-ops on
      // an absent field, so this degrades gracefully if the name is wrong.
      return {
        soundcloudPlays: num(
          (e as Record<string, unknown>).plays ?? (e as Record<string, unknown>).current_plays,
        ),
        chartVelocity,
        spotifyPopularity,
      };
    case "spotify":
    case "applemusic":
      return { spotifyDailyStreams: num(e.current_plays), chartVelocity, spotifyPopularity };
  }
}

function toPooledRow(feed: ChartmetricFeed, e: ChartRow): PooledRow | null {
  const row: PooledRow = {
    feed: feed.id,
    title: extractTitle(e),
    artist: extractArtist(e as Record<string, unknown>),
    releaseYear: parseReleaseYear(e.release_dates ?? e.release_date),
    cmTrack: str(e.cm_track),
    isrc: normalizeIsrc(e.isrc),
    // Only the Spotify chart carries the Spotify id inline; elsewhere it's null
    // and resolveSpotifyId backfills it from (artist, title) downstream.
    spotifyId: feed.id === "spotify" ? str(e.spotify_track_id) : null,
    genres: [],
    signals: feedSignals(feed.id, e),
    raw: e,
  };
  return isResolvable(row) ? row : null;
}

/** Pull every configured feed. Each client call already degrades to [] on error. */
export async function gatherPool(env: Env, country: string, now: Date): Promise<PooledRow[]> {
  const rows: PooledRow[] = [];
  for (const feed of FEEDS) {
    for (const item of await getChart(feed, country, now, env)) {
      const r = toPooledRow(feed, item);
      if (r) rows.push(r);
    }
  }
  return rows;
}

/** Stable dedup key: identity fields first, then artist::title. */
function dedupKey(row: PooledRow): string {
  return (
    row.isrc ??
    (row.cmTrack && `cm:${row.cmTrack}`) ??
    (row.spotifyId && `spotify:${row.spotifyId}`) ??
    artistTitleKey(row.artist, row.title)
  );
}

/** Feed weights for collision resolution (keep the higher-weight feed's row). */
const FEED_WEIGHT = new Map(FEEDS.map((f) => [f.id, f.weight]));

/** Fill nullish signal fields of `into` from `from` (richer combined score). */
function mergeSignals(into: BreakoutSignals, from: BreakoutSignals): BreakoutSignals {
  const out: BreakoutSignals = { ...into };
  for (const k of Object.keys(from) as (keyof BreakoutSignals)[]) {
    if (out[k] == null && from[k] != null) out[k] = from[k];
  }
  return out;
}

/**
 * Dedup the union by key. On collision keep the higher-feed-weight row and fold
 * in the loser's signals + identity fields the winner lacks (a Shazam row and a
 * Spotify row for one track combine into social-momentum + Spotify-maturity =
 * the full breakout gap, inline, with no resolve hop). Genres fold too.
 */
export function dedupePool(rows: PooledRow[]): PooledRow[] {
  const byKey = new Map<string, PooledRow>();
  for (const row of rows) {
    const key = dedupKey(row);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    const [winner, loser] =
      (FEED_WEIGHT.get(row.feed) ?? 0) > (FEED_WEIGHT.get(prev.feed) ?? 0)
        ? [row, prev]
        : [prev, row];
    byKey.set(key, {
      ...winner,
      // Fill identity gaps from the loser so a later sighting that carried, e.g.,
      // the Spotify id isn't lost when the higher-weight feed lacked it.
      cmTrack: winner.cmTrack ?? loser.cmTrack,
      isrc: winner.isrc ?? loser.isrc,
      spotifyId: winner.spotifyId ?? loser.spotifyId,
      signals: mergeSignals(winner.signals, loser.signals),
      genres: winner.genres.length === 0 ? loser.genres : winner.genres,
    });
  }
  return [...byKey.values()];
}
