import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, track } from "@/db/schema";
import { buildEmbedding, derivePrimaryGenre } from "@/lib/embedding";
import type { Env } from "@/server/env";

/**
 * Genre enrichment — Last.fm `track.getTopTags`.
 *
 * Replaces `spotify-metadata.ts`'s artist-genre lookup, which went dead in
 * mid-2026 when new Dev Mode apps started receiving `"genres": null` on
 * every `/v1/artists/{id}` response (see `docs/SOURCES.md`). Last.fm tags
 * are user-applied; the popularity count is the de-noise lever — we keep
 * tags whose count clears `MIN_TAG_COUNT` and cap the top N. The raw tag
 * strings flow into the existing 58-slot genre taxonomy in `embedding.ts`
 * unchanged; matching is its job, not ours.
 *
 * Idempotency: only targets tracks whose `genres` is still empty — a
 * non-empty `genres` array means "done". Track rows without `artist` /
 * `title` skip silently (Last.fm needs the pair to identify the track,
 * `mbid` is not yet persisted).
 */

const API_BASE = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_TIMEOUT_MS = 8_000;

// Last.fm tag counts run 0..100 (top tags saturate at 100, single-user
// fan tags are usually 1-5). 10 keeps the long-tail noise out while
// still admitting moderately-popular genre descriptors.
const MIN_TAG_COUNT = 10;
// A track with eight matched genre slots is already saturated; more is
// taxonomic noise against the keyword matcher.
const MAX_TAGS_PER_TRACK = 8;

type RawLastfmTag = { name?: unknown; count?: unknown };
type GetTopTagsResponse = {
  toptags?: { tag?: RawLastfmTag | RawLastfmTag[] };
  error?: number;
  message?: string;
};

type GenreTarget = {
  id: number;
  artist: string;
  title: string;
  audioFeatures: AudioFeatures | null;
};

/**
 * Enrich genres for a specific set of tracks via Last.fm top-tags.
 * Skips tracks that already have genres or lack artist/title. No-ops
 * without a Last.fm API key.
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
      title: track.title,
      audioFeatures: track.audioFeatures,
    })
    .from(track)
    .where(
      and(
        inArray(track.id, [...trackIds]),
        sql`cardinality(${track.genres}) = 0`,
        isNotNull(track.artist),
        isNotNull(track.title),
      ),
    );
  return applyTagEnrichment(db, env, targets);
}

/**
 * Enrich genres for every track that still has none. Manual / one-off
 * entry point.
 *
 * NOTE: this rebuilds `track.embedding` for tracks that may already be
 * bucketed — running it over the existing catalogue should be followed
 * by a bucket centroid recompute. The daily pipeline uses the per-tracks
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
      title: track.title,
      audioFeatures: track.audioFeatures,
    })
    .from(track)
    .where(
      and(sql`cardinality(${track.genres}) = 0`, isNotNull(track.artist), isNotNull(track.title)),
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

  let updated = 0;
  for (const t of targets) {
    try {
      const raw = await fetchTopTags(t.artist, t.title, env);
      const genres = filterTags(raw);
      if (genres.length === 0) continue;
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
      console.error(`[lastfm-tags] enrichment failed for track ${t.id}`, err);
    }
  }
  return { updated };
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
  return cleaned.slice(0, MAX_TAGS_PER_TRACK).map((t) => t.name);
}

async function fetchTopTags(artist: string, title: string, env: Env): Promise<RawLastfmTag[]> {
  const url = new URL(API_BASE);
  url.searchParams.set("method", "track.getTopTags");
  url.searchParams.set("artist", artist);
  url.searchParams.set("track", title);
  // Let Last.fm fix minor spelling so e.g. "beyonce" hits Beyoncé's tags.
  url.searchParams.set("autocorrect", "1");
  url.searchParams.set("api_key", env.LASTFM_API_KEY);
  url.searchParams.set("format", "json");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LASTFM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.error(`[lastfm-tags] HTTP ${res.status} for "${artist}" — "${title}"`);
      return [];
    }
    const data = (await res.json()) as GetTopTagsResponse;
    // Last.fm signals API errors in-body with HTTP 200 (error 6 = track not
    // found, 8 = operation failed, etc.). None of them are fatal — treat as
    // "no tags" so bucketing falls back on audio-only signal.
    if (typeof data?.error === "number") return [];
    const tag = data?.toptags?.tag;
    if (!tag) return [];
    return Array.isArray(tag) ? tag : [tag];
  } catch (err) {
    console.error(`[lastfm-tags] threw for "${artist}" — "${title}"`, err);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
