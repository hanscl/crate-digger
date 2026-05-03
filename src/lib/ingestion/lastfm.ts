import type { Env } from "@/server/env";
import type { SourceAdapter } from "./adapter";
import type { RawCandidate, SimilarPullParams } from "./types";

const API_BASE = "https://ws.audioscrobbler.com/2.0/";

type LastfmArtistObj = string | { name?: string; "#text"?: string };

export type LastfmTrack = {
  name: string;
  artist: LastfmArtistObj;
  mbid?: string;
  duration?: string | number;
  match?: string;
};

function artistName(a: LastfmArtistObj): string {
  if (typeof a === "string") return a;
  return a.name ?? a["#text"] ?? "";
}

type DurationUnit = "ms" | "seconds";

function parseDurationMs(d: string | number | undefined, unit: DurationUnit): number | null {
  if (d === undefined || d === null) return null;
  const n = typeof d === "string" ? Number.parseInt(d, 10) : d;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Last.fm's APIs are inconsistent: chart.getTopTracks / track.search return
  // seconds, track.getInfo returns ms. Caller passes the unit explicitly so a
  // long DJ mix (e.g. 4200s) doesn't get silently misclassified.
  return unit === "seconds" ? n * 1000 : n;
}

const LASTFM_TIMEOUT_MS = 8_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Coerce caller-supplied limit to a positive integer in [1, MAX_LIMIT]. */
function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(raw), MAX_LIMIT));
}

async function lastfmGet<T>(
  method: string,
  query: Record<string, string | number>,
  env: Env,
): Promise<T | null> {
  const url = new URL(API_BASE);
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", env.LASTFM_API_KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LASTFM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.error(`[lastfm] ${method} ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[lastfm] ${method} threw`, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function lastfmTrackToCandidate(t: LastfmTrack, unit: DurationUnit): RawCandidate {
  const id = t.mbid && t.mbid.length > 0 ? t.mbid : `${artistName(t.artist)}::${t.name}`;
  return {
    source: "lastfm",
    sourceTrackId: id,
    isrc: null,
    spotifyId: null,
    title: t.name,
    artist: artistName(t.artist),
    album: null,
    releaseYear: null,
    durationMs: parseDurationMs(t.duration, unit),
    genres: [],
    rawPayload: t,
  };
}

async function pullSearch(query: string, limit: number, env: Env): Promise<RawCandidate[]> {
  const data = await lastfmGet<{
    results?: { trackmatches?: { track?: LastfmTrack[] | LastfmTrack } };
  }>("track.search", { track: query, limit: Math.min(limit, 50) }, env);
  const raw = data?.results?.trackmatches?.track;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((t) => lastfmTrackToCandidate(t, "seconds"));
}

async function pullSimilar(
  params: SimilarPullParams,
  limit: number,
  env: Env,
): Promise<RawCandidate[]> {
  if (!params.seedArtist || !params.seedTrack) return [];
  const data = await lastfmGet<{
    similartracks?: { track?: LastfmTrack[] | LastfmTrack };
  }>(
    "track.getSimilar",
    {
      artist: params.seedArtist,
      track: params.seedTrack,
      limit: Math.min(limit, 100),
    },
    env,
  );
  const raw = data?.similartracks?.track;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((t) => lastfmTrackToCandidate(t, "seconds"));
}

async function pullTrending(limit: number, env: Env): Promise<RawCandidate[]> {
  const data = await lastfmGet<{ tracks?: { track?: LastfmTrack[] | LastfmTrack } }>(
    "chart.getTopTracks",
    { limit: Math.min(limit, 50) },
    env,
  );
  const raw = data?.tracks?.track;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((t) => lastfmTrackToCandidate(t, "seconds"));
}

export const lastfmAdapter: SourceAdapter = {
  id: "lastfm",
  isPaid: false,
  isAvailable(env) {
    return env.LASTFM_API_KEY.length > 0;
  },
  async pullCandidates(params, env) {
    if (!this.isAvailable(env)) return [];
    const limit = clampLimit(params.limit);
    try {
      switch (params.mode) {
        case "search":
          return params.query ? await pullSearch(params.query, limit, env) : [];
        case "similar":
          return await pullSimilar(params, limit, env);
        case "trending":
          return await pullTrending(limit, env);
      }
    } catch (err) {
      console.error("[lastfm] pullCandidates threw — degrading to []", err);
      return [];
    }
  },
};
