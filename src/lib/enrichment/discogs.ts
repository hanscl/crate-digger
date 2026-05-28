import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, track } from "@/db/schema";
import { buildEmbedding, derivePrimaryGenre } from "@/lib/embedding";
import { mergeGenres } from "@/lib/enrichment/lastfm-tags";
import { createRateLimiter, fetchWithRetry } from "@/lib/enrichment/rate-limit";
import type { Env } from "@/server/env";

/**
 * Genre enrichment — Discogs master/release lookup.
 *
 * Third of three layered genre sources (after Last.fm artist tags and
 * MusicBrainz recording). Discogs provides a curated `genres[]` list plus
 * a richer `styles[]` sub-genre layer ("Synth-pop", "Indietronica", etc.)
 * that the broader Last.fm/MB folksonomy lacks. Particularly useful for
 * indie/electronic catalogues where sub-genre granularity matters.
 *
 * Lookup chain per track:
 *   1. Search masters with `q="<artist> <title>"`. If a hit, fetch the
 *      master and read `genres` + `styles`.
 *   2. Otherwise search releases. If a hit, fetch the release and read
 *      the same fields.
 *   3. Both miss → mark processed, skip.
 *
 * Rate limit: paced at 1200ms (≈50 req/min) for safety headroom under the
 * 60/min authenticated ceiling. Effective throughput is ~16–25 tracks/min
 * given the 2–3 calls per track (search + detail, sometimes search twice).
 *
 * Auth: consumer key/secret passed as URL params per Discogs' read-only
 * model — no per-user OAuth needed. User-Agent is required by Discogs.
 *
 * Idempotency / merge: same model as the other layers. Append
 * `'discogs'` to `genre_sources_processed` on every completed pass
 * (success, no-hit, error). Merge tags additively into `track.genres`;
 * rebuild embedding.
 */

const SOURCE_ID = "discogs" as const;

const DISCOGS_API_BASE = "https://api.discogs.com";
const USER_AGENT = "CrateDigger/0.1 +https://github.com/anthropics/crate-digger";

// 50 req/min == 1200ms interval, safely below Discogs' 60/min auth ceiling.
const discogsLimiter = createRateLimiter(1_200);

type GenreTarget = {
  id: number;
  artist: string;
  title: string;
  audioFeatures: AudioFeatures | null;
  genres: string[];
};

type DiscogsSearchResult = { id?: number; type?: string };
type DiscogsSearchResponse = { results?: DiscogsSearchResult[] };
type DiscogsMasterOrRelease = { genres?: unknown; styles?: unknown };

/**
 * Enrich genres for a specific set of tracks via Discogs master/release
 * lookup. No-ops without `DISCOGS_KEY` + `DISCOGS_SECRET`.
 */
export async function enrichGenresFromDiscogs(
  db: Database,
  env: Env,
  trackIds: readonly number[],
): Promise<{ updated: number }> {
  if (trackIds.length === 0) return { updated: 0 };
  if (!env.DISCOGS_KEY || !env.DISCOGS_SECRET) return { updated: 0 };
  const targets = await db
    .select({
      id: track.id,
      artist: track.artist,
      title: track.title,
      audioFeatures: track.audioFeatures,
      genres: track.genres,
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
  return applyDiscogsEnrichment(db, env, targets);
}

/**
 * Enrich genres for every track Discogs hasn't processed yet. Manual /
 * one-off entry point.
 */
export async function enrichAllGenresFromDiscogs(
  db: Database,
  env: Env,
): Promise<{ requested: number; updated: number }> {
  if (!env.DISCOGS_KEY || !env.DISCOGS_SECRET) return { requested: 0, updated: 0 };
  const targets = await db
    .select({
      id: track.id,
      artist: track.artist,
      title: track.title,
      audioFeatures: track.audioFeatures,
      genres: track.genres,
    })
    .from(track)
    .where(
      and(
        sql`NOT (${SOURCE_ID} = ANY(${track.genreSourcesProcessed}))`,
        isNotNull(track.artist),
        isNotNull(track.title),
      ),
    );
  const result = await applyDiscogsEnrichment(db, env, targets);
  return { requested: targets.length, ...result };
}

async function applyDiscogsEnrichment(
  db: Database,
  env: Env,
  targets: GenreTarget[],
): Promise<{ updated: number }> {
  if (targets.length === 0) return { updated: 0 };
  let updated = 0;
  for (const t of targets) {
    try {
      const tags = await lookupTrack(t.artist, t.title, env);
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
      console.error(`[discogs] enrichment failed for track ${t.id}`, err);
    }
  }
  return { updated };
}

/** Master-first lookup; falls back to release; returns the merged genre+style list. */
async function lookupTrack(artist: string, title: string, env: Env): Promise<string[]> {
  const query = `${artist} ${title}`.trim();
  const masterHit = await searchTopHit(query, "master", env);
  if (masterHit) {
    const tags = await fetchEntityTags(`/masters/${masterHit}`, env);
    if (tags.length > 0) return tags;
  }
  const releaseHit = await searchTopHit(query, "release", env);
  if (releaseHit) {
    const tags = await fetchEntityTags(`/releases/${releaseHit}`, env);
    if (tags.length > 0) return tags;
  }
  return [];
}

async function searchTopHit(
  query: string,
  type: "master" | "release",
  env: Env,
): Promise<number | null> {
  const url = new URL(`${DISCOGS_API_BASE}/database/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("type", type);
  url.searchParams.set("per_page", "1");
  url.searchParams.set("key", env.DISCOGS_KEY);
  url.searchParams.set("secret", env.DISCOGS_SECRET);
  const res = await discogsLimiter.schedule(() =>
    fetchWithRetry(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    }),
  );
  if (!res) return null;
  let data: DiscogsSearchResponse;
  try {
    data = (await res.json()) as DiscogsSearchResponse;
  } catch {
    return null;
  }
  const first = data.results?.[0];
  return typeof first?.id === "number" ? first.id : null;
}

async function fetchEntityTags(path: string, env: Env): Promise<string[]> {
  const url = new URL(`${DISCOGS_API_BASE}${path}`);
  url.searchParams.set("key", env.DISCOGS_KEY);
  url.searchParams.set("secret", env.DISCOGS_SECRET);
  const res = await discogsLimiter.schedule(() =>
    fetchWithRetry(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    }),
  );
  if (!res) return [];
  let data: DiscogsMasterOrRelease;
  try {
    data = (await res.json()) as DiscogsMasterOrRelease;
  } catch {
    return [];
  }
  const genres = stringArray(data.genres);
  const styles = stringArray(data.styles);
  // Genres are the coarse axis ("Electronic"), styles the useful sub-axis
  // ("Synth-pop", "Indietronica"). Both feed the 58-slot keyword matcher.
  return mergeGenres(genres, styles);
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

async function markProcessed(db: Database, trackId: number): Promise<void> {
  await db
    .update(track)
    .set({
      genreSourcesProcessed: sql`array_append(${track.genreSourcesProcessed}, ${SOURCE_ID})`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(track.id, trackId));
}
