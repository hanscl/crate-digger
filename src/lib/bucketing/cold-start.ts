import { enrichGenresFromDiscogs } from "@/lib/enrichment/discogs";
import { resolveCandidate } from "@/lib/enrichment/resolve";
import { enrichGenresFromLastfm } from "@/lib/enrichment/lastfm-tags";
import { enrichGenresFromMusicBrainz } from "@/lib/enrichment/musicbrainz";
import { enrichAudioFeaturesForTracks } from "@/lib/enrichment/reccobeats";
import {
  type SpotifyTrack,
  fetchPlaylistTrackItems,
  spotifyGet,
  spotifyTrackToCandidate,
} from "@/lib/ingestion/spotify";
import type { Database } from "@/db/client";
import type { BucketMemberOrigin } from "@/db/schema";
import type { RawCandidate } from "@/lib/ingestion/types";
import type { Env } from "@/server/env";
import { assignTrack, type AssignResult, loadAssignConfig } from "./assign";

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

/**
 * Run a list of already-resolved track IDs through bucket assignment with
 * `is_cold_start_seed=true` for any newly-spawned bucket. `origin` records
 * WHICH seeding flow created the memberships (LAB-61 provenance) — the
 * playlist and track-paste entry points pass their own label. Idempotent:
 * tracks already in a bucket are returned with `alreadyAssigned=true` and
 * don't mutate state (the existing row's origin is left untouched).
 */
export async function seedBucketsFromTrackIds(
  db: Database,
  trackIds: readonly number[],
  origin: BucketMemberOrigin,
): Promise<ColdStartResult> {
  const assignments: AssignResult[] = [];
  const spawned = new Set<number>();
  const joined = new Set<number>();

  // Config is stable across a seeding run — load it once instead of letting
  // assignTrack re-read app_config + model_version for every track.
  const config = await loadAssignConfig(db);
  for (const id of trackIds) {
    const result = await assignTrack(db, id, { origin, coldStartSeed: true, ...config });
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

  const tracks = await fetchPlaylistTrackItems(playlistId, env);
  const candidates: RawCandidate[] = tracks.map(spotifyTrackToCandidate);

  const trackIds: number[] = [];
  for (const c of candidates) {
    const r = await resolveCandidate(db, c);
    trackIds.push(r.trackId);
  }

  // Best-effort enrichment, same order as the daily pipeline: ReccoBeats
  // audio features first, then the layered genre sources (Last.fm →
  // MusicBrainz → Discogs). Each step degrades silently — a track missing
  // any signal still buckets, just on partial input.
  await enrichAudioFeaturesForTracks(db, trackIds);
  await enrichGenresFromLastfm(db, env, trackIds);
  await enrichGenresFromMusicBrainz(db, env, trackIds);
  await enrichGenresFromDiscogs(db, env, trackIds);

  return seedBucketsFromTrackIds(db, trackIds, "seed_playlist");
}

/**
 * Workaround for the Nov 2024 Spotify cliff: `/playlists/{id}/tracks` returns
 * 403 for new Dev Mode apps when the playlist is user-generated, even when
 * public. `/tracks/{id}` still works on new apps, so the user can paste a list
 * of track URLs and we ingest them individually.
 *
 * Tracked as LAB-20; the proper fix (Spotify user OAuth) is LAB-21.
 */
export async function seedBucketsFromSpotifyTrackIds(
  db: Database,
  env: Env,
  spotifyTrackIds: readonly string[],
): Promise<ColdStartResult | null> {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;
  const deduped = [...new Set(spotifyTrackIds.map((s) => s.trim()).filter(Boolean))];
  if (deduped.length === 0) {
    return {
      trackCount: 0,
      assignedCount: 0,
      alreadyAssignedCount: 0,
      spawnedBuckets: [],
      joinedBuckets: [],
      assignments: [],
    };
  }

  const candidates: RawCandidate[] = [];
  for (const id of deduped) {
    const track = await spotifyGet<SpotifyTrack>(`/tracks/${id}`, {}, env);
    if (track) candidates.push(spotifyTrackToCandidate(track));
  }

  const trackIds: number[] = [];
  for (const c of candidates) {
    const r = await resolveCandidate(db, c);
    trackIds.push(r.trackId);
  }

  await enrichAudioFeaturesForTracks(db, trackIds);
  await enrichGenresFromLastfm(db, env, trackIds);
  await enrichGenresFromMusicBrainz(db, env, trackIds);
  await enrichGenresFromDiscogs(db, env, trackIds);

  return seedBucketsFromTrackIds(db, trackIds, "seed_track");
}
