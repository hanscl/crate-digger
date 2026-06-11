import { createRateLimiter, fetchWithRetry } from "@/lib/enrichment/rate-limit";
import type { Env } from "@/server/env";
import type { TikTokTrendingProvider } from "./tiktok";
import type { RawCandidate } from "./types";

/**
 * Chartmetric provider for the TikTok-velocity adapter (LAB-19) — the default.
 *
 * Chartmetric's `/charts/tiktok` endpoint returns TikTok's trending-tracks
 * chart (TikTok Creative Center data) for a country + interval. It is the
 * cost-effective vendor for a single-user install: usage-based at ~$0.01 per
 * credit with a free trial, versus Soundcharts' $250/mo floor — so this is the
 * preferred provider (see the precedence list in `tiktok.ts`).
 *
 * Auth is a refresh-token exchange: POST the long-lived refresh token to
 * `/api/token` for a short-lived (~1h) bearer, cached in-process and reused
 * until a minute before expiry. Subsequent calls send `Authorization: Bearer`.
 *
 * ⚠️ Chartmetric has no open sandbox, so the response envelope below is
 * modelled from the API docs, NOT verified against the live API (same posture
 * as `reccobeats.ts`). `parseChartEntries` accepts the plausible shapes
 * (`{obj:[…]}`, `{obj:{data:[…]}}`, bare array, `{data:[…]}`) and field
 * extraction tries the documented + conventional key names; anything
 * unrecognised degrades to "no candidates" rather than crashing. Re-confirm
 * field names against a live response (stored on `track_source.raw_payload`)
 * before relying on coverage. Constraint #1: paid + optional.
 */

const CHARTMETRIC_BASE = "https://api.chartmetric.com";
const TOKEN_PATH = "/api/token";
const TIKTOK_CHART_PATH = "/api/charts/tiktok";

/** Default chart territory; overridable via env. */
export const DEFAULT_TIKTOK_COUNTRY = "US";
/** `type=tracks` is the song chart (vs videos/users); weekly = a stable velocity window. */
const TIKTOK_CHART_TYPE = "tracks";
const TIKTOK_CHART_INTERVAL = "weekly";
/** Hard ceiling on rows pulled per run. */
const MAX_CHART_ROWS = 50;

/** Module-scoped limiter so concurrent runs share one budget (also reuses Retry-After backoff). */
const rateLimiter = createRateLimiter(250);

/** Velocity signal stashed on `RawCandidate.rawPayload` (persists to track_source.raw_payload). */
export type ChartmetricVelocity = {
  provider: "chartmetric";
  country: string;
  interval: string;
  /** Chart rank; 1 = top. */
  rank: number | null;
  /** Prior-period rank, when the chart reports it (for velocity). */
  preRank: number | null;
};

type TokenCache = { token: string; expiresAt: number };
let tokenCache: TokenCache | undefined;
let tokenInFlight: Promise<string | null> | undefined;

/** Test hook — clears the cached access token (mirrors `_resetSpotifyTokenCache`). */
export function _resetChartmetricTokenCache(): void {
  tokenCache = undefined;
  tokenInFlight = undefined;
}

async function fetchAccessToken(env: Env): Promise<string | null> {
  const res = await fetchWithRetry(`${CHARTMETRIC_BASE}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshtoken: env.CHARTMETRIC_REFRESH_TOKEN }),
  });
  if (!res) return null;
  try {
    const data = (await res.json()) as { token?: string; expires_in?: number };
    if (!data.token) {
      console.error("[chartmetric] token response missing `token`");
      return null;
    }
    const ttlSeconds = typeof data.expires_in === "number" ? data.expires_in : 3600;
    // Expire a minute early so a long pull never sends an about-to-die token.
    tokenCache = { token: data.token, expiresAt: Date.now() + ttlSeconds * 1000 - 60_000 };
    return tokenCache.token;
  } catch {
    console.error("[chartmetric] token response was not valid JSON");
    return null;
  }
}

async function getAccessToken(env: Env): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  // Dedupe concurrent token requests onto one in-flight exchange.
  if (!tokenInFlight) {
    tokenInFlight = fetchAccessToken(env).finally(() => {
      tokenInFlight = undefined;
    });
  }
  return tokenInFlight;
}

/** Authenticated GET + JSON parse. Returns null on any failure (token, HTTP, parse). */
async function cmGet<T>(path: string, env: Env): Promise<T | null> {
  const token = await getAccessToken(env);
  if (!token) return null;
  const res = await rateLimiter.schedule(() =>
    fetchWithRetry(`${CHARTMETRIC_BASE}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    console.error(`[chartmetric] non-JSON response for ${path}`);
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/** Walk the plausible Chartmetric chart envelopes down to the entry array. */
function parseChartEntries(json: unknown): Record<string, unknown>[] {
  const root = isRecord(json) ? json : {};
  const obj = root.obj;
  const candidates: unknown[] = [obj, isRecord(obj) ? obj.data : undefined, root.data, json];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter(isRecord);
  }
  return [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizeIsrc(raw: unknown): string | null {
  const s = str(raw);
  return s ? s.toUpperCase() : null;
}

/** Title across the documented + conventional key names. */
function extractTitle(e: Record<string, unknown>): string | null {
  return str(e.name) ?? str(e.track_title) ?? str(e.title) ?? str(e.track_name);
}

/** Artist from `artist_names` (string[] | string), `artists` ({name}[]), or `artist_name`. */
function extractArtist(e: Record<string, unknown>): string {
  const raw = e.artist_names ?? e.artists ?? e.artist_name;
  if (Array.isArray(raw)) {
    return raw
      .map((n) => (typeof n === "string" ? n : isRecord(n) ? (str(n.name) ?? "") : ""))
      .filter((s) => s.length > 0)
      .join(", ");
  }
  return str(raw) ?? "";
}

function extractIsrc(e: Record<string, unknown>): string | null {
  const isrc = e.isrc ?? (Array.isArray(e.isrcs) ? e.isrcs[0] : undefined);
  return normalizeIsrc(isrc);
}

/** A stable per-row id for `track_source`: Chartmetric track id → ISRC → artist::title. */
function extractSourceTrackId(
  e: Record<string, unknown>,
  isrc: string | null,
  artist: string,
  title: string,
): string {
  const ids = isRecord(e.chartmetric_ids) ? e.chartmetric_ids : undefined;
  const id = e.id ?? e.cm_track ?? e.chartmetric_id ?? ids?.track;
  const idStr = num(id) !== null ? String(id) : str(id);
  return idStr ?? isrc ?? `${artist}::${title}`;
}

function spotifyIdFromEntry(e: Record<string, unknown>): string | null {
  const ids = isRecord(e.chartmetric_ids) ? e.chartmetric_ids : undefined;
  const sp =
    e.spotify_track_id ??
    (Array.isArray(e.spotify_track_ids) ? e.spotify_track_ids[0] : undefined) ??
    ids?.spotify;
  return str(sp);
}

function toCandidate(e: Record<string, unknown>, country: string): RawCandidate | null {
  const title = extractTitle(e);
  if (!title) return null;
  const artist = extractArtist(e);
  const isrc = extractIsrc(e);
  // Neither ISRC nor a usable (artist,title) pair → unresolvable; drop it.
  if (!isrc && artist.length === 0) return null;
  const velocity: ChartmetricVelocity = {
    provider: "chartmetric",
    country,
    interval: TIKTOK_CHART_INTERVAL,
    rank: num(e.rank) ?? num(e.position) ?? null,
    preRank: num(e.pre_rank) ?? num(e.prev_rank) ?? null,
  };
  return {
    source: "tiktok",
    sourceTrackId: extractSourceTrackId(e, isrc, artist, title),
    isrc,
    spotifyId: spotifyIdFromEntry(e),
    title,
    artist,
    album: null,
    releaseYear: null,
    durationMs: null,
    genres: [],
    // Keep the raw entry so the real field shape is inspectable on the first
    // live run (the verification aid the docs couldn't give us).
    rawPayload: { velocity, raw: e },
  };
}

async function pullTrending(limit: number, env: Env): Promise<RawCandidate[]> {
  const country = env.CHARTMETRIC_TIKTOK_COUNTRY?.trim() || DEFAULT_TIKTOK_COUNTRY;
  const rows = Math.max(1, Math.min(limit, MAX_CHART_ROWS));
  // `date` is intentionally omitted so the endpoint returns the latest chart
  // for the interval (avoids guessing whether today's chart is computed yet).
  const qs = new URLSearchParams({
    type: TIKTOK_CHART_TYPE,
    interval: TIKTOK_CHART_INTERVAL,
    country_code: country,
    limit: String(rows),
    offset: "0",
  });
  const data = await cmGet<unknown>(`${TIKTOK_CHART_PATH}?${qs.toString()}`, env);
  const entries = parseChartEntries(data).slice(0, rows);
  const out: RawCandidate[] = [];
  for (const e of entries) {
    const candidate = toCandidate(e, country);
    if (candidate) out.push(candidate);
  }
  return out;
}

export const chartmetricProvider: TikTokTrendingProvider = {
  id: "chartmetric",
  isConfigured(env) {
    return env.CHARTMETRIC_REFRESH_TOKEN.length > 0;
  },
  pullTrending,
};
