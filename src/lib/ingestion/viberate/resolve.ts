/**
 * Stage 2 — resolution (LAB-90). Turns a selected `PooledRow` into one carrying
 * an ISRC (so resolve.ts/the DB can dedup it and ReccoBeats can pick it up) and,
 * for feeds without inline Spotify maturity, fills that in so the final breakout
 * score reflects the real social-vs-Spotify gap. One or two Viberate calls per
 * shortlisted row — budgeted by the pull-size throttle (the caller resolves only
 * the selected shortlist, not the whole pool). Never throws.
 */

import type { Env } from "@/server/env";
import { num } from "./breakout";
import { getStatsAlltime, getTrackByYoutube, getTrackDetails } from "./client";
import type { PooledRow, ViberateTrackDetails } from "./types";
import { normalizeIsrc, parseReleaseYear } from "./util";

/** Fold a details/by-channel response into a pooled row (ISRC, genres, year, uuid). */
function applyDetails(row: PooledRow, d: ViberateTrackDetails): void {
  row.isrc ??= normalizeIsrc(d.isrc);
  if (typeof d.uuid === "string" && d.uuid.trim().length > 0) row.uuid ??= d.uuid.trim();
  if (row.releaseYear === null) row.releaseYear = parseReleaseYear(d.release_date);
  const genres = new Set(row.genres);
  if (typeof d.genre?.name === "string" && d.genre.name.trim()) genres.add(d.genre.name.trim());
  for (const sg of d.subgenres ?? []) {
    if (typeof sg?.name === "string" && sg.name.trim()) genres.add(sg.name.trim());
  }
  row.genres = [...genres];
}

/**
 * Resolve a single shortlisted row in place. Spotify-trending rows already
 * carry ISRC + Spotify id and need no call. Composite rows resolve their ISRC
 * via `/details` (their breakout gap is already inline). YouTube rows resolve
 * via `/by-channel/youtube/{id}` (ISRC) then `/stats-alltime` (Spotify maturity
 * for the gap). Failures leave the row unresolved — it can still dedup by
 * (artist, title) and get its Spotify id stamped downstream by resolveSpotifyId.
 *
 * Note: we rely on the downstream resolveSpotifyId (artist+title search, on
 * Spotify's own rate budget) to stamp the Spotify id rather than spending a
 * Viberate call on `/track/{uuid}/links`. If audio-feature coverage proves low
 * for these obscure tracks, `/links` (channel "spotify" → authoritative
 * `link_id`) is the upgrade path — at +1 Viberate call per shortlisted row.
 */
export async function resolveRow(row: PooledRow, env: Env): Promise<PooledRow> {
  try {
    if (row.feed === "composite-chart" && row.uuid) {
      const d = await getTrackDetails(row.uuid, env);
      if (d) applyDetails(row, d);
    } else if (row.feed === "youtube-trending" && row.youtubeId) {
      const d = await getTrackByYoutube(row.youtubeId, env);
      if (d) applyDetails(row, d);
      if (row.uuid) {
        const stats = await getStatsAlltime(row.uuid, env);
        if (stats) {
          row.signals.spotifyStreamsTotal ??= num(stats["spotify-streams"]);
          row.signals.spotifyPlaylistReach ??= num(stats["spotify-playlist_reach"]);
          row.signals.shazamTotal ??= num(stats["shazam-shazams"]);
          row.signals.soundcloudTotal ??= num(stats["soundcloud-plays"]);
        }
      }
    }
  } catch (err) {
    console.error("[viberate] resolveRow threw — using unresolved row", err);
  }
  return row;
}
