import type { Env } from "@/server/env";
import type { SourceAdapter } from "./adapter";
import type { RawCandidate, SimilarPullParams } from "./types";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const SPOTIFY_TIMEOUT_MS = 8_000;
const DEFAULT_LIMIT = 25;
/**
 * Feb 2026 Dev Mode caps `/search` `limit` at 10 (was 50). We page with
 * `offset` to still honour the caller's requested limit; `SEARCH_MAX_PAGES`
 * bounds the call count (<=50 results, <=5 requests per search).
 */
const SEARCH_PAGE_SIZE = 10;
const SEARCH_MAX_PAGES = 5;
/**
 * Every pull mode (search/trending/similar) routes through `pullSearch`, so
 * the real ceiling on results is one full page sweep. Clamping above it
 * would just silently truncate.
 */
const MAX_LIMIT = SEARCH_PAGE_SIZE * SEARCH_MAX_PAGES;

/** Coerce caller-supplied limit to a positive integer in [1, MAX_LIMIT]. */
function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(raw), MAX_LIMIT));
}

type SpotifyArtist = { id: string; name: string };
type SpotifyAlbum = {
  id: string;
  name: string;
  release_date?: string;
};
export type SpotifyTrack = {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  external_ids?: { isrc?: string };
  duration_ms?: number;
};

/** Accepts URL, URI, or bare 22-char Spotify track ID. Returns null if it doesn't parse. */
export function parseSpotifyTrackRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const urlMatch = /\btrack\/([A-Za-z0-9]+)/.exec(trimmed);
  if (urlMatch?.[1]) return urlMatch[1];
  const uriMatch = /^spotify:track:([A-Za-z0-9]+)$/i.exec(trimmed);
  if (uriMatch?.[1]) return uriMatch[1];
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
  return null;
}

type TokenCache = { token: string; expiresAt: number };
let tokenCache: TokenCache | undefined;
let tokenInFlight: Promise<string | null> | undefined;

export function _resetSpotifyTokenCache(): void {
  tokenCache = undefined;
  tokenInFlight = undefined;
}

async function fetchAccessToken(env: Env): Promise<string | null> {
  const creds = `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(creds).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[spotify] token request failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return tokenCache.token;
  } catch (err) {
    console.error("[spotify] token request threw", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken(env: Env): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.token;
  }
  // Coalesce concurrent refreshes: if one is already running, wait on it
  // instead of firing a parallel POST that would overwrite the first result.
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = fetchAccessToken(env).finally(() => {
    tokenInFlight = undefined;
  });
  return tokenInFlight;
}

/**
 * Authenticated Spotify catalog GET. Returns null on auth/rate-limit/error
 * so callers can fall back gracefully without try/catch noise. Exported for
 * reuse by enrichment modules that hit the same API surface.
 */
export async function spotifyGet<T>(
  path: string,
  query: Record<string, string | number>,
  env: Env,
): Promise<T | null> {
  const token = await getAccessToken(env);
  if (!token) return null;
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[spotify] ${path} ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[spotify] ${path} threw`, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseReleaseYear(d: string | undefined): number | null {
  if (!d) return null;
  const year = Number.parseInt(d.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

export function spotifyTrackToCandidate(t: SpotifyTrack): RawCandidate {
  return {
    source: "spotify",
    sourceTrackId: t.id,
    isrc: t.external_ids?.isrc?.trim().toUpperCase() ?? null,
    spotifyId: t.id,
    title: t.name,
    artist: t.artists.map((a) => a.name).join(", "),
    album: t.album?.name ?? null,
    releaseYear: parseReleaseYear(t.album?.release_date),
    durationMs: t.duration_ms ?? null,
    genres: [],
    rawPayload: t,
  };
}

/**
 * Field-scoped `/search` for a single artist+title pair, returning the RAW
 * top hits (possibly empty) so the caller can confidence-check before
 * trusting any of them. Used by the ingest-time spotify-id resolution pass
 * (LAB-46) to stamp a `spotifyId` onto Last.fm-only candidates. Reuses
 * `spotifyGet`, which already returns null on auth/rate-limit/non-200 — no
 * separate fetch path.
 *
 * Returns several hits (LAB-62): Spotify ranks by its own relevance, so the
 * top hit for a classic-catalog track is often a dash-suffixed reissue
 * ("… - 2016 Remaster") while the better-matching plain version sits a few
 * slots down. The caller scores each hit and keeps the best.
 */
export async function searchSpotifyTrack(
  artist: string,
  title: string,
  env: Env,
): Promise<SpotifyTrack[]> {
  // Raw Last.fm strings can contain double-quotes (e.g. `"Weird Al" Yankovic`),
  // which would terminate the field-scoped phrase early and malform the query.
  // Strip quotes (and collapse the resulting whitespace) before interpolation.
  const clean = (s: string): string => s.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  const q = `artist:"${clean(artist)}" track:"${clean(title)}"`;
  const data = await spotifyGet<{ tracks: { items: SpotifyTrack[] } }>(
    "/search",
    { q, type: "track", limit: 5 },
    env,
  );
  return data?.tracks?.items ?? [];
}

/**
 * Lookup by ISRC (LAB-118): the Spotify `/search` API accepts `q=isrc:<ISRC>`,
 * and an ISRC is a globally-unique recording identifier — so a hit IS the
 * canonical Spotify recording, no fuzzy confidence-check needed. Returns the
 * raw top hit (limit 1; 0 or 1 result in practice) so the caller can stamp the
 * id directly. Reuses `spotifyGet` (null on auth/rate-limit/non-200). Used by
 * the ingest-time resolution pass to recover tracks whose messy (often
 * YouTube-derived) artist/title would fuzzy-miss the field-scoped search.
 */
export async function searchSpotifyTrackByIsrc(isrc: string, env: Env): Promise<SpotifyTrack[]> {
  const data = await spotifyGet<{ tracks: { items: SpotifyTrack[] } }>(
    "/search",
    { q: `isrc:${isrc.trim().toUpperCase()}`, type: "track", limit: 1 },
    env,
  );
  return data?.tracks?.items ?? [];
}

/**
 * Search, paging with `offset` to assemble up to `limit` results out of
 * 10-track pages (the Feb 2026 Dev Mode cap). Stops early on an empty/short
 * page or a missing `next` cursor.
 */
async function pullSearch(query: string, limit: number, env: Env): Promise<RawCandidate[]> {
  const out: RawCandidate[] = [];
  const pages = Math.min(Math.ceil(limit / SEARCH_PAGE_SIZE), SEARCH_MAX_PAGES);
  for (let page = 0; page < pages && out.length < limit; page++) {
    const data = await spotifyGet<{ tracks: { items: SpotifyTrack[]; next: string | null } }>(
      "/search",
      { q: query, type: "track", limit: SEARCH_PAGE_SIZE, offset: page * SEARCH_PAGE_SIZE },
      env,
    );
    if (!data) break;
    const items = data.tracks?.items ?? [];
    out.push(...items.map(spotifyTrackToCandidate));
    if (items.length < SEARCH_PAGE_SIZE || !data.tracks?.next) break;
  }
  return out.slice(0, limit);
}

async function pullTrending(limit: number, env: Env): Promise<RawCandidate[]> {
  const year = new Date().getUTCFullYear();
  return pullSearch(`year:${year}`, limit, env);
}

async function pullSimilar(
  params: SimilarPullParams,
  limit: number,
  env: Env,
): Promise<RawCandidate[]> {
  // `/v1/recommendations` — the only seed-id-based "similar" endpoint — was
  // retired for apps created after 2024-11-27 and is gone entirely under
  // Feb 2026 Dev Mode. The sole surviving path is an artist+title search;
  // a bare seed id has no replacement and degrades to an empty pool.
  if (params.seedArtist && params.seedTrack) {
    return pullSearch(`artist:${params.seedArtist} track:${params.seedTrack}`, limit, env);
  }
  return [];
}

export const spotifyAdapter: SourceAdapter = {
  id: "spotify",
  isPaid: false,
  isAvailable(env) {
    return env.SPOTIFY_CLIENT_ID.length > 0 && env.SPOTIFY_CLIENT_SECRET.length > 0;
  },
  async pullCandidates(params, env) {
    if (!this.isAvailable(env)) return [];
    const limit = clampLimit(params.limit);
    try {
      switch (params.mode) {
        case "search":
          return params.query ? await pullSearch(params.query, limit, env) : [];
        case "trending":
          return await pullTrending(limit, env);
        case "similar":
          return await pullSimilar(params, limit, env);
      }
    } catch (err) {
      console.error("[spotify] pullCandidates threw — degrading to []", err);
      return [];
    }
  },
};
