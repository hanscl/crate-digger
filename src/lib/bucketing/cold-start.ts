import { resolveCandidate } from "@/lib/enrichment/resolve";
import { enrichAudioFeaturesForTracks } from "@/lib/enrichment/spotify-features";
import { type SpotifyTrack, spotifyGet, spotifyTrackToCandidate } from "@/lib/ingestion/spotify";
import type { Database } from "@/db/client";
import type { RawCandidate } from "@/lib/ingestion/types";
import type { Env } from "@/server/env";
import { assignTrack, type AssignOptions, type AssignResult } from "./assign";

/**
 * Aggregate result of seeding the bucket space from a list of tracks.
 * `assignments` is the per-track audit log; `spawnedBuckets` and
 * `joinedBuckets` are the unique bucket IDs touched. The caller can use
 * these to render a "cold-start summary" on the Setup screen.
 */
export type ColdStartResult = {
  trackCount: number;
  assignedCount: number;
  alreadyAssignedCount: number;
  spawnedBuckets: number[];
  joinedBuckets: number[];
  assignments: AssignResult[];
};

const COLD_START_OPTIONS: AssignOptions = { coldStartSeed: true };

/**
 * Run a list of already-resolved track IDs through bucket assignment with
 * `is_cold_start_seed=true` for any newly-spawned bucket. Idempotent: tracks
 * already in a bucket are returned with `alreadyAssigned=true` and don't
 * mutate state.
 */
export async function seedBucketsFromTrackIds(
  db: Database,
  trackIds: readonly number[],
): Promise<ColdStartResult> {
  const assignments: AssignResult[] = [];
  const spawned = new Set<number>();
  const joined = new Set<number>();

  for (const id of trackIds) {
    const result = await assignTrack(db, id, COLD_START_OPTIONS);
    assignments.push(result);
    if (result.alreadyAssigned) continue;
    if (result.spawned) spawned.add(result.bucketId);
    else joined.add(result.bucketId);
  }

  return {
    trackCount: trackIds.length,
    assignedCount: assignments.filter((a) => !a.alreadyAssigned).length,
    alreadyAssignedCount: assignments.filter((a) => a.alreadyAssigned).length,
    spawnedBuckets: [...spawned],
    joinedBuckets: [...joined],
    assignments,
  };
}

/** Accepts URL, URI, or bare 22-char ID. Returns null when input doesn't parse. */
export function parseSpotifyPlaylistRef(ref: string): string | null {
  const trimmed = ref.trim();
  const urlMatch = /\bplaylist\/([A-Za-z0-9]+)/.exec(trimmed);
  if (urlMatch?.[1]) return urlMatch[1];
  const uriMatch = /^spotify:playlist:([A-Za-z0-9]+)$/i.exec(trimmed);
  if (uriMatch?.[1]) return uriMatch[1];
  if (/^[A-Za-z0-9]+$/.test(trimmed) && trimmed.length >= 16 && trimmed.length <= 32) {
    return trimmed;
  }
  return null;
}

const SPOTIFY_PLAYLIST_PAGE_SIZE = 100;
const SPOTIFY_PLAYLIST_MAX_PAGES = 20; // hard cap: 2000 tracks per playlist seed

type SpotifyPlaylistTracksPage = {
  items: { track: SpotifyTrack | null }[];
  next: string | null;
};

/**
 * Cold-start happy path: fetch a Spotify playlist's tracks, resolve each
 * through enrichment (creating `track` rows), backfill audio features for
 * the new IDs, and run them through `assignTrack` with the cold-start flag.
 *
 * Returns null when the playlist ref is unparseable or Spotify credentials
 * are unavailable. The caller (tRPC route, Setup screen) renders a
 * "couldn't fetch" state in that case rather than throwing.
 */
export async function seedBucketsFromSpotifyPlaylist(
  db: Database,
  env: Env,
  playlistRef: string,
): Promise<ColdStartResult | null> {
  const playlistId = parseSpotifyPlaylistRef(playlistRef);
  if (!playlistId) return null;
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;

  const candidates: RawCandidate[] = [];
  for (let page = 0; page < SPOTIFY_PLAYLIST_MAX_PAGES; page++) {
    const data = await spotifyGet<SpotifyPlaylistTracksPage>(
      `/playlists/${playlistId}/tracks`,
      { limit: SPOTIFY_PLAYLIST_PAGE_SIZE, offset: page * SPOTIFY_PLAYLIST_PAGE_SIZE },
      env,
    );
    if (!data) break;
    for (const item of data.items) {
      if (item.track) candidates.push(spotifyTrackToCandidate(item.track));
    }
    if (!data.next) break;
  }

  const trackIds: number[] = [];
  for (const c of candidates) {
    const r = await resolveCandidate(db, c);
    trackIds.push(r.trackId);
  }

  // Best-effort audio enrichment. If Spotify retired `/audio-features` for
  // this app the call returns silently and tracks bucket on genres alone
  // (audio dims default to 0.5 — see `audioFeaturesToVector`).
  await enrichAudioFeaturesForTracks(db, env, trackIds);

  return seedBucketsFromTrackIds(db, trackIds);
}
