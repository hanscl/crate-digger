import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, track, trackSource } from "@/db/schema";
import { buildEmbedding, derivePrimaryGenre } from "@/lib/embedding";
import { type SpotifyTrack, spotifyGet } from "@/lib/ingestion/spotify";
import type { Env } from "@/server/env";

/**
 * Spotify metadata enrichment — genres via artist lookup.
 *
 * Spotify `/search` track results carry no genres (genres live on the
 * artist object), so every Spotify-sourced track lands with empty `genres`
 * and a dead 58-slot genre half of the embedding. This enricher fills that
 * gap: it reads the stored Spotify payload to recover artist ids, looks up
 * each artist's genres, and rewrites `genres` / `primary_genre` /
 * `embedding`.
 *
 * Why individual `GET /artists/{id}` calls: the batch `/artists?ids=`
 * endpoint was removed for new Dev Mode apps (Feb 2026). The single-artist
 * endpoint survives. Artist genres are cached per run so a shared artist is
 * fetched once.
 *
 * Idempotency: only targets tracks whose `genres` is still empty — a
 * non-empty `genres` array means "done". (Audio features moved to
 * ReccoBeats; see `reccobeats.ts`.)
 */

type SpotifyArtistFull = { id: string; name: string; genres?: string[] };

type GenreTarget = { id: number; audioFeatures: AudioFeatures | null };

/**
 * Enrich genres for a specific set of tracks. Skips tracks that already
 * have genres or carry no `spotify_id`. No-ops without Spotify credentials.
 */
export async function enrichGenresFromArtists(
  db: Database,
  env: Env,
  trackIds: readonly number[],
): Promise<{ updated: number }> {
  if (trackIds.length === 0) return { updated: 0 };
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return { updated: 0 };

  const targets = await db
    .select({ id: track.id, audioFeatures: track.audioFeatures })
    .from(track)
    .where(
      and(
        inArray(track.id, [...trackIds]),
        isNotNull(track.spotifyId),
        sql`cardinality(${track.genres}) = 0`,
      ),
    );
  return applyGenreEnrichment(db, env, targets);
}

/**
 * Enrich genres for every Spotify-sourced track that still has none.
 *
 * Manual / one-off entry point. NOTE: this rebuilds `track.embedding` for
 * tracks that may already be bucketed — running it over the existing
 * catalogue should be followed by a bucket centroid recompute. The daily
 * pipeline uses the per-tracks variant above, before bucketing.
 */
export async function enrichAllGenresFromArtists(
  db: Database,
  env: Env,
): Promise<{ requested: number; updated: number }> {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    return { requested: 0, updated: 0 };
  }
  const targets = await db
    .select({ id: track.id, audioFeatures: track.audioFeatures })
    .from(track)
    .where(and(isNotNull(track.spotifyId), sql`cardinality(${track.genres}) = 0`));
  const result = await applyGenreEnrichment(db, env, targets);
  return { requested: targets.length, ...result };
}

async function applyGenreEnrichment(
  db: Database,
  env: Env,
  targets: GenreTarget[],
): Promise<{ updated: number }> {
  if (targets.length === 0) return { updated: 0 };

  const artistGenreCache = new Map<string, string[]>();
  let updated = 0;

  for (const t of targets) {
    // One track's failure (DB error, malformed payload, unexpected throw)
    // must not abort the rest of the batch — log it with the track id and
    // move on.
    try {
      const artistIds = await loadSpotifyArtistIds(db, t.id);
      if (artistIds.length === 0) continue;

      const genreSet = new Set<string>();
      for (const artistId of artistIds) {
        for (const g of await fetchArtistGenres(artistId, env, artistGenreCache)) {
          genreSet.add(g);
        }
      }
      if (genreSet.size === 0) continue;

      const genres = [...genreSet];
      // Genres feed 58 of the 64 embedding dims — a genre fill that does not
      // rebuild the embedding is invisible to bucketing and ranking.
      const embedding = buildEmbedding({ audioFeatures: t.audioFeatures, genres });
      await db
        .update(track)
        .set({
          genres,
          primaryGenre: derivePrimaryGenre(genres),
          embedding,
          updatedAt: sql`NOW()`,
        })
        .where(eq(track.id, t.id));
      updated += 1;
    } catch (err) {
      console.error(`[spotify-metadata] genre enrichment failed for track ${t.id}`, err);
    }
  }
  return { updated };
}

/** Pull artist ids out of the stored Spotify `RawCandidate.rawPayload`. */
async function loadSpotifyArtistIds(db: Database, trackId: number): Promise<string[]> {
  const [row] = await db
    .select({ rawPayload: trackSource.rawPayload })
    .from(trackSource)
    .where(and(eq(trackSource.trackId, trackId), eq(trackSource.source, "spotify")))
    .limit(1);
  const payload = row?.rawPayload;
  if (!payload || typeof payload !== "object") return [];
  const artists = (payload as Partial<SpotifyTrack>).artists;
  if (!Array.isArray(artists)) return [];
  return artists
    .map((a) => (a && typeof a === "object" ? (a as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Fetch (and cache) an artist's genres via the single-artist endpoint. */
async function fetchArtistGenres(
  artistId: string,
  env: Env,
  cache: Map<string, string[]>,
): Promise<string[]> {
  const cached = cache.get(artistId);
  if (cached) return cached;
  const data = await spotifyGet<SpotifyArtistFull>(`/artists/${artistId}`, {}, env);
  const genres = Array.isArray(data?.genres) ? data.genres : [];
  cache.set(artistId, genres);
  return genres;
}
