/**
 * Stage 1 — the broad pool (LAB-90). Pulls the lead-Spotify feeds, maps each
 * row into a common `PooledRow` (extracting whatever breakout signals are
 * inline and free), and dedups the union. No resolution and no scoring happen
 * here — those are Stages 2/3.
 */

import type { Env } from "@/server/env";
import { FEED_WEIGHTS, num, pickRecent } from "./breakout";
import { getCompositeChart, getSpotifyTrending, getYoutubeTrending } from "./client";
import {
  COMPOSITE_SORTS,
  COMPOSITE_TIMEFRAME,
  POOL_ROWS_PER_FEED,
  YOUTUBE_COUNTRIES,
} from "./config";
import type {
  BreakoutSignals,
  CompositeChartItem,
  PooledRow,
  SpotifyTrendingItem,
  YoutubeTrendingItem,
} from "./types";
import { artistTitleKey, joinArtists, normalizeIsrc, parseReleaseYear } from "./util";

/** A row is unusable if it has no title, or nothing to resolve/dedup on. */
function isResolvable(row: PooledRow): boolean {
  if (row.title.length === 0) return false;
  return Boolean(row.isrc || row.spotifyId || row.uuid || row.youtubeId || row.artist.length > 0);
}

function spotifyRow(item: SpotifyTrendingItem): PooledRow | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const artists = Array.isArray(item.artists) ? item.artists : [];
  const trackId =
    typeof item.track_id === "string" && item.track_id.trim().length > 0
      ? item.track_id.trim()
      : null;
  const row: PooledRow = {
    feed: "spotify-trending",
    title,
    artist: joinArtists(artists),
    artists,
    releaseYear: parseReleaseYear(item.release_date),
    // This feed IS Spotify's chart — track_id is a Spotify track id.
    spotifyId: trackId,
    isrc: normalizeIsrc(item.isrc),
    uuid: null,
    youtubeId: null,
    genres: [],
    signals: {
      spotifySurgePct: num(item.streams_1d_pct),
      spotifyStreamsDay: num(item.streams_1d),
    },
    raw: item,
  };
  return isResolvable(row) ? row : null;
}

function youtubeRow(item: YoutubeTrendingItem): PooledRow | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const artists = Array.isArray(item.artists) ? item.artists : [];
  const youtubeId =
    typeof item.youtube_id === "string" && item.youtube_id.trim().length > 0
      ? item.youtube_id.trim()
      : null;
  const row: PooledRow = {
    feed: "youtube-trending",
    title,
    artist: joinArtists(artists),
    artists,
    releaseYear: parseReleaseYear(item.release_date),
    spotifyId: null,
    isrc: null,
    uuid: null,
    youtubeId,
    genres: [],
    signals: {
      youtubeViews1w: num(item.views_1w),
      youtubeViewsPct: num(item.views_1w_pct),
    },
    raw: item,
  };
  return isResolvable(row) ? row : null;
}

function compositeRow(item: CompositeChartItem): PooledRow | null {
  const title = typeof item.name === "string" ? item.name.trim() : "";
  const artists = Array.isArray(item.artists) ? item.artists : [];
  const uuid =
    typeof item.uuid === "string" && item.uuid.trim().length > 0 ? item.uuid.trim() : null;
  const charts = item.charts ?? null;
  const genreName = typeof item.genre?.name === "string" ? item.genre.name.trim() : "";
  const signals: BreakoutSignals = {
    shazam1w: pickRecent(charts?.shazam?.shazams),
    shazamTotal: num(charts?.shazam?.shazams?.total),
    soundcloud1w: pickRecent(charts?.soundcloud?.plays),
    youtubeViews1w: pickRecent(charts?.youtube?.views),
    spotifyStreamsWeek: num(charts?.spotify?.streams?.["1w"]),
    spotifyStreamsTotal: num(charts?.spotify?.streams?.total),
  };
  const row: PooledRow = {
    feed: "composite-chart",
    title,
    artist: joinArtists(artists),
    artists,
    releaseYear: parseReleaseYear(item.release_date),
    spotifyId: null,
    isrc: null,
    uuid,
    youtubeId: null,
    genres: genreName ? [genreName] : [],
    signals,
    raw: item,
  };
  return isResolvable(row) ? row : null;
}

/** Pull every configured feed. Each client call already degrades to [] on error. */
export async function gatherPool(env: Env, spotifyCountry: string): Promise<PooledRow[]> {
  const rows: PooledRow[] = [];

  for (const item of await getSpotifyTrending(spotifyCountry, POOL_ROWS_PER_FEED, env)) {
    const r = spotifyRow(item);
    if (r) rows.push(r);
  }
  for (const country of YOUTUBE_COUNTRIES) {
    for (const item of await getYoutubeTrending(country, POOL_ROWS_PER_FEED, env)) {
      const r = youtubeRow(item);
      if (r) rows.push(r);
    }
  }
  for (const sort of COMPOSITE_SORTS) {
    for (const item of await getCompositeChart(
      sort,
      COMPOSITE_TIMEFRAME,
      POOL_ROWS_PER_FEED,
      env,
    )) {
      const r = compositeRow(item);
      if (r) rows.push(r);
    }
  }
  return rows;
}

/** Stable dedup key: identity fields first, then artist::title. */
function dedupKey(row: PooledRow): string {
  return (
    row.isrc ??
    (row.spotifyId && `spotify:${row.spotifyId}`) ??
    (row.uuid && `uuid:${row.uuid}`) ??
    (row.youtubeId && `yt:${row.youtubeId}`) ??
    artistTitleKey(row.artist, row.title)
  );
}

/** Fill nullish signal fields of `into` from `from` (richer combined score). */
function mergeSignals(into: BreakoutSignals, from: BreakoutSignals): BreakoutSignals {
  const out: BreakoutSignals = { ...into };
  for (const k of Object.keys(from) as (keyof BreakoutSignals)[]) {
    if (out[k] == null && from[k] != null) out[k] = from[k];
  }
  return out;
}

/**
 * Dedup the union by key. On collision keep the higher-feed-weight row
 * (composite > youtube > spotify) and fold in the signals (and any genres) the
 * loser carries, so a track returned by two sorts/territories scores on the
 * union of its signals. Identity fields aren't folded: by `dedupKey`'s
 * precedence two colliding rows already share the same identity field (a row
 * carrying an ISRC keys on it, never on a uuid). Cross-feed sightings of one
 * track key differently here and are reconciled by ISRC later in resolve.ts/DB.
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
      (FEED_WEIGHTS[row.feed] ?? 0) > (FEED_WEIGHTS[prev.feed] ?? 0) ? [row, prev] : [prev, row];
    winner.signals = mergeSignals(winner.signals, loser.signals);
    if (winner.genres.length === 0 && loser.genres.length > 0) winner.genres = loser.genres;
    byKey.set(key, winner);
  }
  return [...byKey.values()];
}
