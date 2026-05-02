import type { Env } from "@/server/env";
import type { SourceAdapter } from "./adapter";
import type { PullParams, RawCandidate } from "./types";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";

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

type TokenCache = { token: string; expiresAt: number };
let tokenCache: TokenCache | undefined;

export function _resetSpotifyTokenCache(): void {
  tokenCache = undefined;
}

async function getAccessToken(env: Env): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.token;
  }
  const creds = `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(creds).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
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
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`[spotify] ${path} ${res.status}`);
    return null;
  }
  return (await res.json()) as T;
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

async function pullSearch(query: string, limit: number, env: Env): Promise<RawCandidate[]> {
  const data = await spotifyGet<{ tracks: { items: SpotifyTrack[] } }>(
    "/search",
    { q: query, type: "track", limit: Math.min(limit, 50) },
    env,
  );
  if (!data) return [];
  return data.tracks.items.map(spotifyTrackToCandidate);
}

async function pullTrending(limit: number, env: Env): Promise<RawCandidate[]> {
  const year = new Date().getUTCFullYear();
  return pullSearch(`year:${year}`, limit, env);
}

async function pullSimilar(params: PullParams, limit: number, env: Env): Promise<RawCandidate[]> {
  const seed = params.seedSourceId;
  if (!seed) {
    if (params.seedArtist && params.seedTrack) {
      return pullSearch(`artist:${params.seedArtist} track:${params.seedTrack}`, limit, env);
    }
    return [];
  }
  // /v1/recommendations was retired for apps created after 2024-11-27. We try
  // it for backward compatibility with existing apps; when unavailable the
  // call returns null and we degrade to an empty pool.
  const data = await spotifyGet<{ tracks: SpotifyTrack[] }>(
    "/recommendations",
    { seed_tracks: seed, limit: Math.min(limit, 100) },
    env,
  );
  if (!data) return [];
  return data.tracks.map(spotifyTrackToCandidate);
}

export const spotifyAdapter: SourceAdapter = {
  id: "spotify",
  isPaid: false,
  isAvailable(env) {
    return env.SPOTIFY_CLIENT_ID.length > 0 && env.SPOTIFY_CLIENT_SECRET.length > 0;
  },
  async pullCandidates(params, env) {
    if (!this.isAvailable(env)) return [];
    const limit = params.limit ?? 25;
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
