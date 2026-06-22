/**
 * Chartmetric Music API client (LAB-117).
 *
 * Thin typed wrapper over the endpoints the breakout engine uses. Auth is a
 * refresh-token exchange: POST the long-lived refresh token to `/api/token` for
 * a short-lived (~1h) bearer, cached in-process and reused until a minute before
 * expiry (lifted from the retired LAB-19 provider, the one piece of it that was
 * correct). Every call routes through one module-scoped rate limiter and the
 * shared `fetchWithRetry` (429-aware backoff), labelled `chartmetric`. Each
 * function returns parsed data or `null`/`[]` on ANY failure — callers degrade
 * to an empty pool (Constraint #1); nothing here throws.
 *
 * Shapes verified live in the LAB-117 spike (`scripts/lab-chartmetric-engine-probe.ts`).
 */

import { createRateLimiter, fetchWithRetry } from "@/lib/enrichment/rate-limit";
import type { Env } from "@/server/env";
import { DATE_LADDER, POOL_ROWS_PER_FEED } from "./config";
import type { ChartRow, ChartmetricFeed, TrackDetails } from "./types";
import { isoDaysAgo } from "./util";

export const CHARTMETRIC_BASE = "https://api.chartmetric.com";
const TOKEN_PATH = "/api/token";

/** Chartmetric tolerates a brisk cadence; one limiter shared across concurrent runs. */
const rateLimiter = createRateLimiter(250);

/**
 * Chart feeds are computed ON-DEMAND server-side: the first request for a given
 * (country, date) is a cold-cache miss that Chartmetric builds and caches, which
 * runs 5–20s (Shazam is the heaviest — 200 rows); every later call that day hits
 * the warm cache at ~250ms. The daily pipeline is the first/only consumer of
 * each fresh date, so it ALWAYS pays the cold path. Under the shared 8s fetch
 * timeout every cold compute aborted mid-flight, the cache never warmed, and the
 * weight-1.0 Shazam feed was silently dropped each run while ~39s/date-rung was
 * burned on a doomed retry storm (verified live: cold 4.9–20.3s, warm ~0.25s;
 * see scripts/lab-shazam-spike.ts + scripts/lab-shazam-latency.ts).
 *
 * So chart calls get a patient timeout that outlasts the cold compute: attempt 1
 * now completes the cold build and warms the cache, so retries never fire on the
 * cold path at all. Retry COUNT is deliberately left at the shared default — an
 * earlier draft also cut it to 1, but with the timeout fixed that only stripped
 * transient-error budget from the fast feeds (SoundCloud/TikTok/Spotify ~250ms,
 * no cold-cache issue) for no benefit. Scoped to chart calls; the per-track
 * resolve stays on the shared 8s default.
 */
const CHART_TIMEOUT_MS = 30_000;

type TokenCache = { token: string; expiresAt: number };
let tokenCache: TokenCache | undefined;
let tokenInFlight: Promise<string | null> | undefined;

/** Test hook — clears the cached access token (mirrors `_resetSpotifyTokenCache`). */
export function _resetChartmetricTokenCache(): void {
  tokenCache = undefined;
  tokenInFlight = undefined;
}

async function fetchAccessToken(env: Env): Promise<string | null> {
  const res = await fetchWithRetry(
    `${CHARTMETRIC_BASE}${TOKEN_PATH}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshtoken: env.CHARTMETRIC_REFRESH_TOKEN }),
    },
    { label: "chartmetric" },
  );
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
async function cmGet<T>(path: string, env: Env, timeoutMs?: number): Promise<T | null> {
  const token = await getAccessToken(env);
  if (!token) return null;
  const res = await rateLimiter.schedule(() =>
    fetchWithRetry(
      `${CHARTMETRIC_BASE}${path}`,
      { method: "GET", headers: { authorization: `Bearer ${token}` } },
      { label: "chartmetric", timeoutMs },
    ),
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
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Walk the Chartmetric envelope ({obj:[…]} | {obj:{data:[…]}} | {data:[…]} | bare) to the row array. */
function parseChartEntries(json: unknown): ChartRow[] {
  const root = isRecord(json) ? json : {};
  const obj = root.obj;
  const candidates: unknown[] = [obj, isRecord(obj) ? obj.data : undefined, root.data, json];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter(isRecord) as ChartRow[];
  }
  return [];
}

/** Unwrap a single-object Chartmetric response ({obj} | {data} | bare). */
function unwrapObject(json: unknown): unknown {
  const root = isRecord(json) ? json : {};
  return root.obj ?? root.data ?? json;
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/**
 * Pull one chart feed. Charts require a `date` and lag a few days with no
 * reliable "latest", so walk the cadence's date ladder and return the first
 * date that yields rows (sliced to POOL_ROWS_PER_FEED). `now` is injected so
 * the engine is testable without a clock.
 *
 * Returns `null` when the feed is UNREACHABLE — not one date-rung call returned
 * a successful response (`cmGet` null = token/HTTP/parse failure on every rung,
 * e.g. an expired refresh token or a 400 storm). That's distinct from `[]` (at
 * least one rung succeeded but the chart was empty), so `gatherPool` can fail
 * loud when every feed is unreachable rather than silent-zero-fill (LAB-86).
 */
export async function getChart(
  feed: ChartmetricFeed,
  country: string,
  now: Date,
  env: Env,
): Promise<ChartRow[] | null> {
  let reached = false;
  for (const daysAgo of DATE_LADDER[feed.cadence]) {
    const date = isoDaysAgo(now, daysAgo);
    const json = await cmGet(
      `${feed.path}?${qs(feed.query(country, date))}`,
      env,
      CHART_TIMEOUT_MS,
    );
    if (json !== null) reached = true;
    const rows = parseChartEntries(json);
    if (rows.length > 0) return rows.slice(0, POOL_ROWS_PER_FEED);
  }
  return reached ? [] : null;
}

/**
 * `GET /api/track/{cm_track}` — the one optional resolve hop. Returns the track
 * detail (genres) + `cm_statistics` (the cross-platform maturity snapshot).
 */
export async function getTrackDetails(cmTrack: string, env: Env): Promise<TrackDetails | null> {
  const data = await cmGet<unknown>(`/api/track/${encodeURIComponent(cmTrack)}`, env);
  const obj = unwrapObject(data);
  return isRecord(obj) ? (obj as TrackDetails) : null;
}
