import { createRateLimiter, fetchWithRetry } from "@/lib/enrichment/rate-limit";
import type { Env } from "@/server/env";
import type { TikTokTrendingProvider } from "./tiktok";
import type { RawCandidate } from "./types";

/**
 * Soundcharts provider for the TikTok-velocity adapter (LAB-19).
 *
 * Soundcharts exposes TikTok's "Breakout" charts — the daily, per-country
 * velocity list lifted from TikTok's Creative Center (songs gaining momentum,
 * 50 rows). That is exactly the discovery signal we want: tracks trending on
 * TikTok, fed through the normal enrich → bucket → rank → surface pipeline.
 *
 * Two calls per charted track:
 *   1. `GET /chart/song/{slug}/ranking/latest` → ranked items carrying a
 *      Soundcharts song UUID, name, credited artist, chart position and the
 *      velocity signal (`positionEvolution`, `timeOnChart`).
 *   2. `GET /song/{uuid}` → the song's ISRC (chart rows carry no ISRC), so
 *      `resolve.ts` can dedupe ISRC-first against Spotify/Last.fm sightings.
 *      Best-effort: if the lookup fails we still emit the candidate and fall
 *      back to fuzzy `(artist, title)` resolution.
 *
 * Auth is two static headers (`x-app-id` / `x-api-key`) — no token exchange.
 * The free tier grants 1,000 production requests; the public sandbox
 * (`soundcharts` / `soundcharts`) serves fixed demo data for development.
 *
 * Constraint #1: this is a paid, OPTIONAL source. Absent credentials the
 * adapter reports unavailable and the system runs on Spotify + Last.fm.
 */

const SOUNDCHARTS_BASE = "https://customer.api.soundcharts.com";

/** US "Breakout" velocity chart — overridable per install via env. */
export const DEFAULT_TIKTOK_CHART_SLUG = "tiktok-breakout-us";

/** Hard ceiling on rows pulled per run; the Breakout charts hold 50. */
const MAX_CHART_ROWS = 50;

/**
 * Module-scoped limiter so concurrent runs share one budget. Soundcharts sets
 * no hard rate limit (recommends <=10k/min); we issue only a handful of calls
 * per run, but routing through the shared limiter reuses the `Retry-After`
 * backoff in `fetchWithRetry` and keeps us a polite client.
 */
const rateLimiter = createRateLimiter(250);

/** Velocity signal stashed on `RawCandidate.rawPayload` (persists to track_source.raw_payload). */
export type TikTokVelocity = {
  provider: "soundcharts";
  chartSlug: string;
  /** 1 = top of the chart. */
  position: number | null;
  /** Positions gained since the prior ranking; positive = climbing. */
  positionEvolution: number | null;
  /** Consecutive rankings the track has appeared on. */
  timeOnChart: number | null;
  /** ISO timestamp of the ranking snapshot. */
  rankDate: string | null;
};

type ChartItem = {
  song?: { uuid?: string; name?: string; creditName?: string } | null;
  position?: number;
  positionEvolution?: number;
  timeOnChart?: number;
  rankDate?: string;
};

type ChartRankingResponse = { items?: ChartItem[] | null };

type SongObject = {
  uuid?: string;
  name?: string;
  isrc?: string | null;
  creditName?: string | null;
  mainArtists?: { name?: string }[] | null;
  /** Soundcharts reports duration in SECONDS. */
  duration?: number | null;
  releaseDate?: string | null;
};

type SongResponse = { object?: SongObject | null };

function headers(env: Env): Record<string, string> {
  return { "x-app-id": env.SOUNDCHARTS_APP_ID, "x-api-key": env.SOUNDCHARTS_API_KEY };
}

/** GET + JSON-parse with the shared retry/backoff. Returns null on any failure. */
async function scGet<T>(path: string, env: Env): Promise<T | null> {
  const res = await rateLimiter.schedule(() =>
    fetchWithRetry(`${SOUNDCHARTS_BASE}${path}`, { method: "GET", headers: headers(env) }),
  );
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    console.error(`[soundcharts] non-JSON response for ${path}`);
    return null;
  }
}

function chartSlug(env: Env): string {
  // Zod fills the default only when the key is ABSENT; an explicitly-empty
  // `SOUNDCHARTS_TIKTOK_CHART_SLUG=` still reaches the `|| DEFAULT` fallback.
  const configured = env.SOUNDCHARTS_TIKTOK_CHART_SLUG.trim();
  return configured.length > 0 ? configured : DEFAULT_TIKTOK_CHART_SLUG;
}

function normalizeIsrc(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return v.length > 0 ? v : null;
}

/** Year out of an ISO date string (slice, not Date, to avoid TZ drift). */
function parseReleaseYear(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.length < 4) return null;
  const year = Number.parseInt(raw.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

function durationMsFromSeconds(seconds: number | null | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/** Best-effort ISRC + clean metadata lookup for a charted song UUID. */
async function fetchSongMeta(uuid: string, env: Env): Promise<SongObject | null> {
  const data = await scGet<SongResponse>(`/api/v2/song/${encodeURIComponent(uuid)}`, env);
  return data?.object ?? null;
}

function toCandidate(
  item: ChartItem,
  uuid: string,
  title: string,
  slug: string,
  meta: SongObject | null,
): RawCandidate {
  // Prefer the song metadata's primary artist (cleanest for resolution); fall
  // back to the chart row's credited artist string.
  const artist = (
    meta?.mainArtists?.[0]?.name ??
    meta?.creditName ??
    item.song?.creditName ??
    ""
  ).trim();
  const velocity: TikTokVelocity = {
    provider: "soundcharts",
    chartSlug: slug,
    position: typeof item.position === "number" ? item.position : null,
    positionEvolution: typeof item.positionEvolution === "number" ? item.positionEvolution : null,
    timeOnChart: typeof item.timeOnChart === "number" ? item.timeOnChart : null,
    rankDate: typeof item.rankDate === "string" ? item.rankDate : null,
  };
  return {
    source: "tiktok",
    sourceTrackId: uuid,
    isrc: normalizeIsrc(meta?.isrc),
    // No Spotify id from Soundcharts — resolveSpotifyId fills it via search
    // (same path as Last.fm-sourced candidates), unlocking ReccoBeats features.
    spotifyId: null,
    title,
    artist,
    album: null,
    releaseYear: parseReleaseYear(meta?.releaseDate),
    durationMs: durationMsFromSeconds(meta?.duration),
    popularity: null,
    genres: [],
    rawPayload: { velocity, song: item.song ?? null },
  };
}

async function pullTrending(limit: number, env: Env): Promise<RawCandidate[]> {
  const slug = chartSlug(env);
  const rows = Math.max(1, Math.min(limit, MAX_CHART_ROWS));
  const data = await scGet<ChartRankingResponse>(
    `/api/v2/chart/song/${encodeURIComponent(slug)}/ranking/latest?offset=0&limit=${rows}`,
    env,
  );
  // Keep only rows with a usable id + title, then fetch each song's ISRC
  // metadata concurrently. The shared rate limiter still paces the actual
  // requests, so this overlaps response latency rather than bursting.
  const valid = (data?.items ?? []).flatMap((item) => {
    const uuid = item.song?.uuid;
    const title = item.song?.name?.trim();
    return uuid && title ? [{ item, uuid, title }] : [];
  });
  const metas = await Promise.all(valid.map(({ uuid }) => fetchSongMeta(uuid, env)));
  const out: RawCandidate[] = [];
  valid.forEach(({ item, uuid, title }, i) => {
    const candidate = toCandidate(item, uuid, title, slug, metas[i] ?? null);
    // Unresolvable junk: no ISRC AND no artist means neither ISRC nor fuzzy
    // resolution can place it. Drop rather than insert an orphan.
    if (!candidate.isrc && candidate.artist.length === 0) return;
    out.push(candidate);
  });
  return out;
}

export const soundchartsProvider: TikTokTrendingProvider = {
  id: "soundcharts",
  isConfigured(env) {
    return env.SOUNDCHARTS_APP_ID.length > 0 && env.SOUNDCHARTS_API_KEY.length > 0;
  },
  pullTrending,
};
