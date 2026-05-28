import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, track } from "@/db/schema";
import { buildEmbedding, derivePrimaryGenre } from "@/lib/embedding";
import { fetchWithRetry } from "@/lib/enrichment/rate-limit";
import type { Env } from "@/server/env";

/**
 * Genre enrichment — Last.fm `artist.getTopTags`.
 *
 * First of three layered genre sources (Last.fm → MusicBrainz → Discogs).
 * The artist-level top-tags endpoint is the only Last.fm tag path that
 * still serves rich data as of mid-2026; `track.getTopTags` returns empty
 * across the board. Same-artist tracks therefore share a genre subvector
 * — fine for clustering, blind to cross-genre side projects. MusicBrainz
 * + Discogs layers downstream recover per-track signal where available.
 *
 * Spotify track payloads join multi-artist credits as "Artist A, Artist B"
 * in `track.artist`. Last.fm autocorrect can't resolve through that, so
 * we split on `", "` and use the primary artist. Bands with commas in
 * the name ("Crosby, Stills & Nash") get truncated; Last.fm autocorrect
 * usually still resolves the fragment.
 *
 * Tags are user-applied; popularity count is the de-noise lever — we keep
 * tags with count ≥ `MIN_TAG_COUNT` and cap at `MAX_TAGS_PER_ARTIST`. Raw
 * strings flow into the 58-slot keyword matcher in `embedding.ts`
 * unchanged.
 *
 * Idempotency: skip when `'lastfm' ∈ track.genre_sources_processed`. After
 * a completed pass — successful tags, definitive empty result, "Various
 * Artists" skip, or an in-body Last.fm error — `'lastfm'` is appended to
 * the processed list so we never retry. A *hard* fetch failure (network
 * throw, timeout, non-OK HTTP) is the one exception: the row is left
 * unprocessed so a later run retries, rather than silencing the artist for
 * good on a transient blip. The merge into `track.genres` is additive:
 * existing tags from any prior source are preserved, new tags are appended
 * (de-duplicated case-insensitively). The embedding is rebuilt from the
 * merged array.
 */

const API_BASE = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_TIMEOUT_MS = 8_000;

const SOURCE_ID = "lastfm" as const;

// Last.fm tag counts run 0..100. 10 keeps long-tail noise out while still
// admitting moderately-popular genre descriptors.
const MIN_TAG_COUNT = 10;
// Eight matched slots saturates the 58-slot keyword matcher; more is taxonomic noise.
const MAX_TAGS_PER_ARTIST = 8;

type RawLastfmTag = { name?: unknown; count?: unknown };
type GetTopTagsResponse = {
  toptags?: { tag?: RawLastfmTag | RawLastfmTag[] };
  error?: number;
  message?: string;
};

type GenreTarget = {
  id: number;
  artist: string;
  audioFeatures: AudioFeatures | null;
  genres: string[];
};

/**
 * Enrich genres for a specific set of tracks via Last.fm artist top-tags.
 * Skips tracks where Last.fm has already processed them or lacks an
 * artist. No-ops without a Last.fm API key.
 */
export async function enrichGenresFromLastfm(
  db: Database,
  env: Env,
  trackIds: readonly number[],
): Promise<{ updated: number }> {
  if (trackIds.length === 0) return { updated: 0 };
  if (!env.LASTFM_API_KEY) return { updated: 0 };
  const targets = await db
    .select({
      id: track.id,
      artist: track.artist,
      audioFeatures: track.audioFeatures,
      genres: track.genres,
    })
    .from(track)
    .where(
      and(
        inArray(track.id, [...trackIds]),
        sql`NOT (${SOURCE_ID} = ANY(${track.genreSourcesProcessed}))`,
        isNotNull(track.artist),
      ),
    );
  return applyTagEnrichment(db, env, targets);
}

/**
 * Enrich genres for every track Last.fm has not processed yet. Manual /
 * one-off entry point.
 *
 * NOTE: this rebuilds `track.embedding` for tracks that may already be
 * bucketed — running it over the existing catalogue should be followed by
 * a bucket centroid recompute. The daily pipeline uses the per-tracks
 * variant above, before bucketing.
 */
export async function enrichAllGenresFromLastfm(
  db: Database,
  env: Env,
): Promise<{ requested: number; updated: number }> {
  if (!env.LASTFM_API_KEY) return { requested: 0, updated: 0 };
  const targets = await db
    .select({
      id: track.id,
      artist: track.artist,
      audioFeatures: track.audioFeatures,
      genres: track.genres,
    })
    .from(track)
    .where(
      and(sql`NOT (${SOURCE_ID} = ANY(${track.genreSourcesProcessed}))`, isNotNull(track.artist)),
    );
  const result = await applyTagEnrichment(db, env, targets);
  return { requested: targets.length, ...result };
}

async function applyTagEnrichment(
  db: Database,
  env: Env,
  targets: GenreTarget[],
): Promise<{ updated: number }> {
  if (targets.length === 0) return { updated: 0 };

  // null caches a hard fetch failure for the artist within this batch so we
  // don't re-hit a flaky endpoint per-track; those rows stay unprocessed.
  const artistTagCache = new Map<string, string[] | null>();
  let updated = 0;

  for (const t of targets) {
    try {
      const primary = primaryArtist(t.artist);

      // "Various Artists" compilations: artist axis is degenerate; skip the
      // API call but still flag the row processed so we never retry. MB and
      // Discogs (track-level) will carry the genre signal for these.
      if (!primary || isVariousArtists(primary)) {
        await markProcessed(db, t.id);
        continue;
      }

      let tags = artistTagCache.get(primary);
      if (tags === undefined) {
        const raw = await fetchArtistTopTags(primary, env);
        tags = raw === null ? null : filterTags(raw);
        artistTagCache.set(primary, tags);
      }

      // Hard fetch failure (distinct from a definitive empty response): leave
      // the row unprocessed so a later run retries instead of flagging the
      // artist permanently tag-less. Must NOT markProcessed here.
      if (tags === null) continue;

      if (tags.length === 0) {
        // Empty response is a valid terminal state — flag processed so we
        // don't keep hammering Last.fm for an artist it has no tags on.
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
      console.error(`[lastfm-tags] enrichment failed for track ${t.id}`, err);
    }
  }
  return { updated };
}

/** Flag the row processed without writing any genre data. */
async function markProcessed(db: Database, trackId: number): Promise<void> {
  await db
    .update(track)
    .set({
      genreSourcesProcessed: sql`array_append(${track.genreSourcesProcessed}, ${SOURCE_ID})`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(track.id, trackId));
}

/**
 * Merge new tags into the existing genre array, preserving order and
 * de-duplicating case-insensitively. Existing tags win on casing — the
 * first time a name (lowercased) appears, that casing is kept.
 */
export function mergeGenres(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of [...existing, ...incoming]) {
    const key = g.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/**
 * Pull the primary artist out of Spotify's comma-joined multi-artist
 * string. "The Shins, James Mercer" → "The Shins". Single-artist strings
 * pass through unchanged. Returns null when the trimmed result is empty.
 */
export function primaryArtist(joined: string): string | null {
  const head = joined.split(",")[0]?.trim() ?? "";
  return head.length > 0 ? head : null;
}

function isVariousArtists(artist: string): boolean {
  return artist.trim().toLowerCase() === "various artists";
}

function filterTags(raw: RawLastfmTag[]): string[] {
  const cleaned: { name: string; count: number }[] = [];
  for (const t of raw) {
    const name = typeof t?.name === "string" ? t.name.trim() : "";
    const countRaw = t?.count;
    const count =
      typeof countRaw === "number"
        ? countRaw
        : typeof countRaw === "string"
          ? Number.parseInt(countRaw, 10)
          : Number.NaN;
    if (!name) continue;
    if (!Number.isFinite(count) || count < MIN_TAG_COUNT) continue;
    cleaned.push({ name, count });
  }
  cleaned.sort((a, b) => b.count - a.count);
  return cleaned.slice(0, MAX_TAGS_PER_ARTIST).map((t) => t.name);
}

/**
 * Fetch an artist's raw top-tags. Returns the tag list (possibly empty) on a
 * definitive Last.fm response, or `null` when the request hard-failed —
 * network throw, timeout, or non-OK HTTP after `fetchWithRetry`'s transient
 * retries. The caller treats `null` as "retry later" and a non-null array as
 * a terminal answer, so a transient blip can't permanently silence an artist.
 */
async function fetchArtistTopTags(artist: string, env: Env): Promise<RawLastfmTag[] | null> {
  const url = new URL(API_BASE);
  url.searchParams.set("method", "artist.getTopTags");
  url.searchParams.set("artist", artist);
  // Let Last.fm fix minor spelling so e.g. "beyonce" hits Beyoncé's tags.
  url.searchParams.set("autocorrect", "1");
  url.searchParams.set("api_key", env.LASTFM_API_KEY);
  url.searchParams.set("format", "json");

  // Route through fetchWithRetry (like the MusicBrainz/Discogs layers) so a
  // transient throw or 429 is retried with backoff rather than collapsing to
  // an empty list that the caller would flag processed forever.
  const res = await fetchWithRetry(url.toString(), {}, { timeoutMs: LASTFM_TIMEOUT_MS });
  if (!res) return null;
  let data: GetTopTagsResponse;
  try {
    data = (await res.json()) as GetTopTagsResponse;
  } catch (err) {
    // A 200 with an unparseable body is an infra hiccup (truncated response,
    // proxy error page), not a real "no tags" — retry rather than silence.
    console.error(`[lastfm-tags] malformed JSON for "${artist}"`, err);
    return null;
  }
  // Last.fm signals API errors in-body with HTTP 200 (error 6 = artist not
  // found, 8 = operation failed, etc.). Treat as a definitive "no tags" so
  // bucketing falls back on audio-only signal.
  if (typeof data?.error === "number") return [];
  const tag = data?.toptags?.tag;
  if (!tag) return [];
  return Array.isArray(tag) ? tag : [tag];
}
