/**
 * Viberate Music Data API client (LAB-90).
 *
 * Thin typed wrapper over the endpoints the breakout engine uses. Every call
 * routes through one module-scoped rate limiter (~54/min, under the entry-tier
 * 60/window) and the shared `fetchWithRetry` (429-aware backoff), labelled
 * `viberate` so failures aren't misattributed to the ReccoBeats enricher. Each
 * function returns parsed data or `null` on ANY failure — callers degrade to an
 * empty pool (Constraint #1); nothing here throws.
 */

import { createRateLimiter, fetchWithRetry } from "@/lib/enrichment/rate-limit";
import type { Env } from "@/server/env";
import type {
  CompositeChartItem,
  SpotifyTrendingItem,
  ViberateStatsAlltime,
  ViberateTrackDetails,
  YoutubeTrendingItem,
} from "./types";

export const VIBERATE_BASE = "https://data.viberate.com/api/v1";

/**
 * Entry tier is ~60 requests/window (window unit unconfirmed — assumed
 * per-minute). A run issues ~6 chart pulls plus 1–2 resolution calls per
 * shortlisted candidate: ~30 calls at the default throttle, but up to ~106 at
 * MAX_RETURN=50 (all-YouTube). Pacing at ~1.1s (~54/min) keeps the common case
 * comfortably under the limit; the 429/Retry-After backoff is the safety net if
 * the window is tighter or a large limit is configured.
 */
const rateLimiter = createRateLimiter(1100);

function headers(env: Env): Record<string, string> {
  return { "Access-Key": env.VIBERATE_API_KEY, Accept: "application/json" };
}

/**
 * GET + JSON parse through the shared limiter/backoff. Returns the parsed
 * top-level body or null. The query string is built by the caller.
 */
async function vibGet(path: string, env: Env): Promise<unknown | null> {
  const res = await rateLimiter.schedule(() =>
    fetchWithRetry(
      `${VIBERATE_BASE}${path}`,
      { method: "GET", headers: headers(env) },
      { label: "viberate" },
    ),
  );
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    console.error(`[viberate] non-JSON response for ${path}`);
    return null;
  }
}

/**
 * Viberate wraps most payloads under `data`, but the single-track detail
 * endpoints sometimes return the object at the top level. Tolerate both.
 */
function unwrap(json: unknown): unknown {
  if (json && typeof json === "object" && "data" in json) {
    return (json as { data?: unknown }).data;
  }
  return json;
}

function asArray<T>(json: unknown): T[] {
  const d = unwrap(json);
  return Array.isArray(d) ? (d as T[]) : [];
}

function asObject<T>(json: unknown): T | null {
  const d = unwrap(json);
  return d && typeof d === "object" && !Array.isArray(d) ? (d as T) : null;
}

function qs(params: Record<string, string | number>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, String(v));
  return sp.toString();
}

// ---------------------------------------------------------------------------
// Feeds (Stage 1)
// ---------------------------------------------------------------------------

/**
 * Each feed returns the parsed rows, or `null` when the HTTP call itself FAILED
 * (transport error / non-2xx — `vibGet` returns null). `null` is distinct from
 * `[]` (a successful but empty response): `gatherPool` counts the nulls to tell
 * "source went dark" (all feeds failed → fail loud, LAB-86) from "nothing
 * trending right now" (reachable, empty). A non-array-but-present body (200 with
 * `data: null`) is a reachable empty, not a failure → `[]`.
 */
function feedRows<T>(json: unknown | null): T[] | null {
  return json === null ? null : asArray<T>(json);
}

/** Spotify per-country trending (LAB-88 feed), momentum-sorted. */
export async function getSpotifyTrending(
  country: string,
  limit: number,
  env: Env,
): Promise<SpotifyTrendingItem[] | null> {
  const q = qs({ country, sort: "streams_1d_pct", order: "desc", offset: 0, limit });
  return feedRows<SpotifyTrendingItem>(await vibGet(`/track/trending/spotify/country?${q}`, env));
}

/** YouTube per-country trending, sorted by 1-week view momentum. */
export async function getYoutubeTrending(
  country: string,
  limit: number,
  env: Env,
): Promise<YoutubeTrendingItem[] | null> {
  const q = qs({ country, sort: "views_1w_pct", order: "desc", offset: 0, limit });
  return feedRows<YoutubeTrendingItem>(await vibGet(`/track/trending/youtube/country?${q}`, env));
}

/**
 * Global cross-platform composite chart. `sort` selects the lead signal
 * (e.g. `shazam-shazams`, `soundcloud-plays`); rows carry inline `charts` for
 * both the social signal and Spotify maturity.
 */
export async function getCompositeChart(
  sort: string,
  timeframe: string,
  limit: number,
  env: Env,
): Promise<CompositeChartItem[] | null> {
  const q = qs({ sort, timeframe, order: "desc", offset: 0, limit });
  return feedRows<CompositeChartItem>(await vibGet(`/track/viberate/chart?${q}`, env));
}

// ---------------------------------------------------------------------------
// Resolution (Stage 2)
// ---------------------------------------------------------------------------

/** Resolve a YouTube-trending row to a Viberate track (uuid + ISRC + genre). */
export async function getTrackByYoutube(
  youtubeId: string,
  env: Env,
): Promise<ViberateTrackDetails | null> {
  return asObject<ViberateTrackDetails>(
    await vibGet(`/track/by-channel/youtube/${encodeURIComponent(youtubeId)}`, env),
  );
}

/** Track detail by Viberate uuid — the ISRC source for composite-chart rows. */
export async function getTrackDetails(
  uuid: string,
  env: Env,
): Promise<ViberateTrackDetails | null> {
  return asObject<ViberateTrackDetails>(
    await vibGet(`/track/${encodeURIComponent(uuid)}/details`, env),
  );
}

/** Compact cross-platform all-time snapshot; the Spotify-maturity input. */
export async function getStatsAlltime(
  uuid: string,
  env: Env,
): Promise<ViberateStatsAlltime | null> {
  return asObject<ViberateStatsAlltime>(
    await vibGet(`/track/${encodeURIComponent(uuid)}/viberate/stats-alltime`, env),
  );
}
