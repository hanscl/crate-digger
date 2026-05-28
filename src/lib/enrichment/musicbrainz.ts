import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, track } from "@/db/schema";
import { buildEmbedding, derivePrimaryGenre } from "@/lib/embedding";
import { mergeGenres, primaryArtist } from "@/lib/enrichment/lastfm-tags";
import { createRateLimiter, fetchWithRetry } from "@/lib/enrichment/rate-limit";
import type { Env } from "@/server/env";

/**
 * Genre enrichment — MusicBrainz recording lookup.
 *
 * Second of three layered genre sources (after Last.fm artist tags). MB
 * stores BOTH a curated genre list (`genres[]`) and the raw folksonomy
 * (`tags[]`). Recording-level coverage exists for many tracks thanks to
 * the 2021 backfill that propagated Last.fm + Discogs + beatunes tags
 * down to recording entities. Recovers per-track signal that artist-level
 * Last.fm collapses (side projects, "Various Artists" comps).
 *
 * Lookup chain:
 *   1. `track.mbid` already set?            → use it.
 *   2. Otherwise resolve via Last.fm
 *      `track.getInfo` and cache on the row → use it.
 *   3. Still no MBID                        → mark processed, skip.
 *
 * Rate limit: a strict 1 req/s per MusicBrainz' usage policy, enforced via
 * a module-level limiter wrapping every MB call. The Last.fm
 * `track.getInfo` resolution hop is NOT rate-limited (Last.fm is lenient
 * and the call is one-shot, cached forever in `track.mbid`).
 *
 * Idempotency / merge: same model as `lastfm-tags.ts` — skip when
 * `'musicbrainz' ∈ track.genre_sources_processed`, append the flag on
 * every completed pass (including no-MBID and empty-tag cases), merge new
 * tags additively into `track.genres`, rebuild embedding.
 */

const SOURCE_ID = "musicbrainz" as const;

const MB_API_BASE = "https://musicbrainz.org/ws/2";
const LASTFM_API_BASE = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_TIMEOUT_MS = 8_000;

// MusicBrainz publishes a 1 req/s per-IP rate limit. Build the limiter
// once at module scope so all callers within the process share the pacing.
const mbLimiter = createRateLimiter(1_000);

type GenreTarget = {
  id: number;
  artist: string;
  title: string;
  audioFeatures: AudioFeatures | null;
  genres: string[];
  mbid: string | null;
};

type MbTagOrGenre = { name?: unknown; count?: unknown };
type MbRecordingResponse = {
  id?: string;
  title?: string;
  genres?: MbTagOrGenre[];
  tags?: MbTagOrGenre[];
};

type LastfmTrackInfoResponse = {
  track?: { mbid?: unknown };
  error?: number;
};

/**
 * Enrich genres for a specific set of tracks via MusicBrainz recording
 * lookups. Skips tracks already processed by MB or lacking artist/title.
 * No-ops without `MUSICBRAINZ_CONTACT_EMAIL` (required for the User-Agent
 * by MB's API policy).
 */
export async function enrichGenresFromMusicBrainz(
  db: Database,
  env: Env,
  trackIds: readonly number[],
): Promise<{ updated: number }> {
  if (trackIds.length === 0) return { updated: 0 };
  if (!env.MUSICBRAINZ_CONTACT_EMAIL) return { updated: 0 };
  const targets = await db
    .select({
      id: track.id,
      artist: track.artist,
      title: track.title,
      audioFeatures: track.audioFeatures,
      genres: track.genres,
      mbid: track.mbid,
    })
    .from(track)
    .where(
      and(
        inArray(track.id, [...trackIds]),
        sql`NOT (${SOURCE_ID} = ANY(${track.genreSourcesProcessed}))`,
        isNotNull(track.artist),
        isNotNull(track.title),
      ),
    );
  return applyMbEnrichment(db, env, targets);
}

/**
 * Enrich genres for every track MB hasn't processed yet. Manual / one-off
 * entry point — rebuilds embeddings, so post-bucketing runs should be
 * followed by a centroid recompute.
 */
export async function enrichAllGenresFromMusicBrainz(
  db: Database,
  env: Env,
): Promise<{ requested: number; updated: number }> {
  if (!env.MUSICBRAINZ_CONTACT_EMAIL) return { requested: 0, updated: 0 };
  const targets = await db
    .select({
      id: track.id,
      artist: track.artist,
      title: track.title,
      audioFeatures: track.audioFeatures,
      genres: track.genres,
      mbid: track.mbid,
    })
    .from(track)
    .where(
      and(
        sql`NOT (${SOURCE_ID} = ANY(${track.genreSourcesProcessed}))`,
        isNotNull(track.artist),
        isNotNull(track.title),
      ),
    );
  const result = await applyMbEnrichment(db, env, targets);
  return { requested: targets.length, ...result };
}

async function applyMbEnrichment(
  db: Database,
  env: Env,
  targets: GenreTarget[],
): Promise<{ updated: number }> {
  if (targets.length === 0) return { updated: 0 };
  let updated = 0;
  for (const t of targets) {
    try {
      const mbid = await resolveMbid(db, t, env);
      if (!mbid) {
        await markProcessed(db, t.id);
        continue;
      }
      const tags = await fetchRecordingTags(mbid, env);
      if (tags.length === 0) {
        await markProcessed(db, t.id);
        continue;
      }
      const merged = mergeGenres(t.genres, tags);
      const embedding = buildEmbedding({ audioFeatures: t.audioFeatures, genres: merged });
      await db
        .update(track)
        .set({
          genres: merged,
          primaryGenre: derivePrimaryGenre(merged),
          embedding,
          genreSourcesProcessed: sql`array_append(${track.genreSourcesProcessed}, ${SOURCE_ID})`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(track.id, t.id));
      updated += 1;
    } catch (err) {
      console.error(`[musicbrainz] enrichment failed for track ${t.id}`, err);
    }
  }
  return { updated };
}

async function resolveMbid(db: Database, t: GenreTarget, env: Env): Promise<string | null> {
  if (t.mbid) return t.mbid;
  if (!env.LASTFM_API_KEY) return null;
  const primary = primaryArtist(t.artist);
  if (!primary) return null;
  const mbid = await fetchLastfmTrackMbid(primary, t.title, env);
  if (!mbid) return null;
  await db
    .update(track)
    .set({ mbid, updatedAt: sql`NOW()` })
    .where(eq(track.id, t.id));
  return mbid;
}

async function fetchLastfmTrackMbid(
  artist: string,
  title: string,
  env: Env,
): Promise<string | null> {
  const url = new URL(LASTFM_API_BASE);
  url.searchParams.set("method", "track.getInfo");
  url.searchParams.set("artist", artist);
  url.searchParams.set("track", title);
  url.searchParams.set("autocorrect", "1");
  url.searchParams.set("api_key", env.LASTFM_API_KEY);
  url.searchParams.set("format", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LASTFM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as LastfmTrackInfoResponse;
    if (typeof data?.error === "number") return null;
    const mbid = data?.track?.mbid;
    return typeof mbid === "string" && mbid.length > 0 ? mbid : null;
  } catch (err) {
    console.error(`[musicbrainz] track.getInfo threw for "${artist}" — "${title}"`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRecordingTags(mbid: string, env: Env): Promise<string[]> {
  const url = `${MB_API_BASE}/recording/${encodeURIComponent(mbid)}?inc=genres+tags&fmt=json`;
  const userAgent = `CrateDigger/0.1 (mailto:${env.MUSICBRAINZ_CONTACT_EMAIL})`;
  const res = await mbLimiter.schedule(() =>
    fetchWithRetry(url, { headers: { "User-Agent": userAgent, Accept: "application/json" } }),
  );
  if (!res) return [];
  let data: MbRecordingResponse;
  try {
    data = (await res.json()) as MbRecordingResponse;
  } catch (err) {
    console.error(`[musicbrainz] malformed JSON for ${mbid}`, err);
    return [];
  }
  const genres = extractNames(data.genres);
  const tags = extractNames(data.tags);
  // Curated genres first (higher signal), folksonomy tags second. mergeGenres
  // dedupes case-insensitively — entries shared between the two are kept once.
  return mergeGenres(genres, tags);
}

function extractNames(items: MbTagOrGenre[] | undefined): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (name) out.push(name);
  }
  return out;
}

/** Flag the row processed without writing genre data. */
async function markProcessed(db: Database, trackId: number): Promise<void> {
  await db
    .update(track)
    .set({
      genreSourcesProcessed: sql`array_append(${track.genreSourcesProcessed}, ${SOURCE_ID})`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(track.id, trackId));
}
