/**
 * Stage 2 — resolution (LAB-117). Turns a selected `PooledRow` into one whose
 * breakout gap reflects CONTINUOUS Spotify maturity. Chart rows already carry an
 * inline 0–100 `spotify_popularity` (a coarse maturity floor), so resolution is
 * the "continuous gap (Viberate-equivalent)" upgrade Hans chose: ONE
 * `/api/track/{cm_track}` call → `cm_statistics` gives `sp_playlist_total_reach`
 * + `sp_streams` (the real maturity) plus genres. Spotify-chart rows already
 * carry continuous maturity inline (`current_plays`) and skip the call. Budgeted
 * by the pull-size throttle (caller resolves only the shortlist). Never throws.
 */

import type { Env } from "@/server/env";
import { num } from "./breakout";
import { getTrackDetails } from "./client";
import type { PooledRow, TrackDetails } from "./types";
import { normalizeIsrc, parseReleaseYear } from "./util";

/** Fold a track-details response into a pooled row (maturity, social, genres, ISRC). */
function applyDetails(row: PooledRow, d: TrackDetails): void {
  row.isrc ??= normalizeIsrc(d.isrc);
  if (row.releaseYear === null) row.releaseYear = parseReleaseYear(d.release_date);
  const genres = new Set(row.genres);
  for (const g of d.genres ?? []) {
    if (typeof g?.name === "string" && g.name.trim()) genres.add(g.name.trim());
  }
  row.genres = [...genres];

  const cm = d.cm_statistics;
  if (!cm) return;
  // Spotify MATURITY (continuous) — the gap's denominator.
  row.signals.spotifyPlaylistReach ??= num(cm.sp_playlist_total_reach);
  row.signals.spotifyTotalStreams ??= num(cm.sp_streams);
  row.signals.spotifyPopularity ??= num(cm.sp_popularity);
  // Social counts as a fallback when the source chart didn't carry them.
  row.signals.shazamCount ??= num(cm.shazam_counts);
  row.signals.tiktokPosts ??= num(cm.num_tt_videos);
}

/** True once the row already has a CONTINUOUS Spotify-maturity signal (no hop needed). */
function hasContinuousMaturity(row: PooledRow): boolean {
  const s = row.signals;
  return (
    s.spotifyDailyStreams != null || s.spotifyPlaylistReach != null || s.spotifyTotalStreams != null
  );
}

/**
 * Resolve a single shortlisted row in place. Skips the call when continuous
 * maturity is already inline (Spotify-chart rows) or there's no cm_track to
 * resolve on. A failed call leaves the row on its inline `spotify_popularity`
 * floor — still scorable, just coarser.
 */
export async function resolveRow(row: PooledRow, env: Env): Promise<PooledRow> {
  if (hasContinuousMaturity(row) || !row.cmTrack) return row;
  try {
    const d = await getTrackDetails(row.cmTrack, env);
    if (d) applyDetails(row, d);
  } catch (err) {
    console.error("[chartmetric] resolveRow threw — using unresolved row", err);
  }
  return row;
}
