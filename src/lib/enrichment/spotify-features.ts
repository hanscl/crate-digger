import { eq, inArray, isNotNull, isNull, and } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, track } from "@/db/schema";
import type { Env } from "@/server/env";
import { spotifyGet } from "../ingestion/spotify";

const FEATURES_BATCH = 100;

type SpotifyAudioFeatures = {
  id: string;
  tempo: number;
  energy: number;
  valence: number;
  danceability: number;
  acousticness: number;
  instrumentalness: number;
};

function toAudioFeatures(f: SpotifyAudioFeatures): AudioFeatures {
  return {
    tempo: f.tempo,
    energy: f.energy,
    valence: f.valence,
    danceability: f.danceability,
    acousticness: f.acousticness,
    instrumentalness: f.instrumentalness,
  };
}

/**
 * Backfill `track.audio_features` for tracks that have a `spotify_id` but no
 * features yet. Idempotent: only acts on rows where features are null, so
 * re-running over the same set is a no-op.
 *
 * Note: Spotify retired this endpoint for apps registered after 2024-11-27.
 * Old apps still work; new apps degrade silently to "no features fetched".
 */
export async function enrichAudioFeatures(
  db: Database,
  env: Env,
): Promise<{ requested: number; updated: number }> {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    return { requested: 0, updated: 0 };
  }

  const targets = await db
    .select({ id: track.id, spotifyId: track.spotifyId })
    .from(track)
    .where(and(isNotNull(track.spotifyId), isNull(track.audioFeatures)));
  if (targets.length === 0) return { requested: 0, updated: 0 };

  let updated = 0;
  for (let i = 0; i < targets.length; i += FEATURES_BATCH) {
    const batch = targets.slice(i, i + FEATURES_BATCH);
    const ids = batch.map((t) => t.spotifyId).filter((s): s is string => s !== null);
    if (ids.length === 0) continue;

    const data = await spotifyGet<{ audio_features: (SpotifyAudioFeatures | null)[] }>(
      "/audio-features",
      { ids: ids.join(",") },
      env,
    );
    if (!data?.audio_features) continue;

    const bySpotifyId = new Map<string, SpotifyAudioFeatures>();
    for (const f of data.audio_features) if (f) bySpotifyId.set(f.id, f);

    for (const row of batch) {
      const features = row.spotifyId ? bySpotifyId.get(row.spotifyId) : undefined;
      if (!features) continue;
      await db
        .update(track)
        .set({ audioFeatures: toAudioFeatures(features) })
        .where(eq(track.id, row.id));
      updated++;
    }
  }

  return { requested: targets.length, updated };
}

/**
 * Re-enrich a specific set of tracks (e.g. after a manual retry). Same
 * idempotency contract: rows with non-null `audio_features` are skipped.
 */
export async function enrichAudioFeaturesForTracks(
  db: Database,
  env: Env,
  trackIds: readonly number[],
): Promise<{ updated: number }> {
  if (trackIds.length === 0) return { updated: 0 };
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return { updated: 0 };

  const targets = await db
    .select({ id: track.id, spotifyId: track.spotifyId })
    .from(track)
    .where(
      and(
        inArray(track.id, [...trackIds]),
        isNotNull(track.spotifyId),
        isNull(track.audioFeatures),
      ),
    );
  if (targets.length === 0) return { updated: 0 };

  const ids = targets.map((t) => t.spotifyId).filter((s): s is string => s !== null);
  const data = await spotifyGet<{ audio_features: (SpotifyAudioFeatures | null)[] }>(
    "/audio-features",
    { ids: ids.join(",") },
    env,
  );
  if (!data?.audio_features) return { updated: 0 };

  const bySpotifyId = new Map<string, SpotifyAudioFeatures>();
  for (const f of data.audio_features) if (f) bySpotifyId.set(f.id, f);

  let updated = 0;
  for (const row of targets) {
    const features = row.spotifyId ? bySpotifyId.get(row.spotifyId) : undefined;
    if (!features) continue;
    await db
      .update(track)
      .set({ audioFeatures: toAudioFeatures(features) })
      .where(eq(track.id, row.id));
    updated++;
  }
  return { updated };
}
