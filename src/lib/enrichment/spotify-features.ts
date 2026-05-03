import { and, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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

type FeatureUpdate = { id: number; features: AudioFeatures };

/**
 * Apply a batch of (id, features) pairs in a single SQL statement using
 * `UPDATE … SET audio_features = CASE id WHEN … END WHERE id IN (…)`.
 * Replaces what would otherwise be N round-trips per batch.
 */
async function bulkUpdateAudioFeatures(db: Database, updates: FeatureUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const cases = updates.map((u) => sql`WHEN ${u.id} THEN ${JSON.stringify(u.features)}::jsonb`);
  await db
    .update(track)
    .set({
      audioFeatures: sql`CASE ${track.id} ${sql.join(cases, sql.raw(" "))} END`,
    })
    .where(
      inArray(
        track.id,
        updates.map((u) => u.id),
      ),
    );
}

async function fetchAndApplyBatch(
  db: Database,
  env: Env,
  batch: { id: number; spotifyId: string | null }[],
): Promise<number> {
  const ids = batch.map((t) => t.spotifyId).filter((s): s is string => s !== null);
  if (ids.length === 0) return 0;

  const data = await spotifyGet<{ audio_features: (SpotifyAudioFeatures | null)[] }>(
    "/audio-features",
    { ids: ids.join(",") },
    env,
  );
  if (!data?.audio_features) return 0;

  const bySpotifyId = new Map<string, SpotifyAudioFeatures>();
  for (const f of data.audio_features) if (f) bySpotifyId.set(f.id, f);

  const updates: FeatureUpdate[] = [];
  for (const row of batch) {
    const features = row.spotifyId ? bySpotifyId.get(row.spotifyId) : undefined;
    if (!features) continue;
    updates.push({ id: row.id, features: toAudioFeatures(features) });
  }
  await bulkUpdateAudioFeatures(db, updates);
  return updates.length;
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
    updated += await fetchAndApplyBatch(db, env, batch);
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

  let updated = 0;
  for (let i = 0; i < targets.length; i += FEATURES_BATCH) {
    const batch = targets.slice(i, i + FEATURES_BATCH);
    updated += await fetchAndApplyBatch(db, env, batch);
  }
  return { updated };
}
