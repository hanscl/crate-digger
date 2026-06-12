import { createRateLimiter, fetchWithRetry } from "@/lib/enrichment/rate-limit";
import type { Env } from "@/server/env";
import type { SourceAdapter } from "./adapter";
import type { RawCandidate } from "./types";

/**
 * Viberate source adapter (LAB-88).
 *
 * Viberate is a paid music-analytics platform. Its
 * `GET /track/trending/spotify/country` endpoint returns Spotify's per-country
 * daily-streams trending list with a velocity signal (`streams_1d_pct`, daily
 * rank + rank delta) — the same "what's surging right now" discovery signal
 * the TikTok-velocity adapter (LAB-19) draws from TikTok breakout charts, fed
 * through the normal enrich → bucket → rank → surface pipeline.
 *
 * Rows are momentum-sorted (`streams_1d_pct` desc): the biggest 1-day stream
 * gains surface tracks that are *breaking out* — new releases AND catalogue
 * revivals — rather than the perennial top-of-chart a raw `streams_1d` order
 * would return. Each row carries the track's Spotify id (`track_id`) AND its
 * ISRC, so candidates resolve cleanly: the Spotify id unlocks ReccoBeats audio
 * features immediately, and the ISRC dedupes against Spotify/Last.fm sightings
 * in `resolve.ts`.
 *
 * Auth is a single static header (`Access-Key`) — no token exchange.
 *
 * Constraint #1: paid + OPTIONAL. Absent `VIBERATE_API_KEY` the adapter reports
 * unavailable and the system runs unchanged on Spotify + Last.fm. Like the
 * TikTok adapter, Viberate is a trending/chart signal — `similar` and `search`
 * don't map onto a trending chart and degrade to an empty pool (the daily
 * pipeline only ever calls trend adapters in `trending` mode anyway; see
 * `src/mastra/lib/pipeline-steps.ts`).
 *
 * Endpoint shape + auth verified live during the LAB-87 spike (2026-06-12) —
 * see `docs/SOURCES.md` and `scripts/lab87-viberate-probe.ts`.
 */

const VIBERATE_BASE = "https://data.viberate.com/api/v1";

/** Default chart territory (ISO Alpha-2); overridable via `VIBERATE_TRENDING_COUNTRY`. */
export const DEFAULT_TRENDING_COUNTRY = "US";

/** Momentum-first ordering — surfaces breakouts over perennial top-streamers. */
const TRENDING_SORT = "streams_1d_pct";
const TRENDING_ORDER = "desc";

/** Hard ceiling on rows pulled per run. */
const MAX_TRENDING_ROWS = 50;
/** Default when the caller supplies no (or a junk) limit. */
const DEFAULT_LIMIT = 25;

/**
 * Observed quota is 60 requests / window (`GET /rate-limit/status`; the window
 * depends on the API package). A trending pull is a single GET, but routing it
 * through a module-scoped limiter (~54/min) lets concurrent runs share one
 * budget and reuses the `Retry-After`/429 backoff in `fetchWithRetry`.
 */
const rateLimiter = createRateLimiter(1100);

/** Velocity signal stashed on `RawCandidate.rawPayload` (persists to track_source.raw_payload). */
export type ViberateVelocity = {
  provider: "viberate";
  country: string;
  sort: string;
  /** Streams in the last 24h. */
  streams1d: number | null;
  /** % change in 1-day streams vs the prior day; positive = climbing. */
  streams1dPct: number | null;
  /** Daily chart rank; 1 = top. */
  rank: number | null;
  /** Positions gained since the prior ranking; positive = climbing. */
  rankDiff: number | null;
};

type TrendingArtist = { uuid?: string; name?: string; slug?: string };
type TrendingItem = {
  track_id?: string;
  title?: string;
  isrc?: string | null;
  release_date?: string | null;
  artists?: TrendingArtist[] | null;
  streams_1d?: number;
  streams_1d_pct?: number;
  ranks?: { rank?: number; rank_diff?: number } | null;
};
type TrendingResponse = { data?: TrendingItem[] | null };

function headers(env: Env): Record<string, string> {
  return { "Access-Key": env.VIBERATE_API_KEY, Accept: "application/json" };
}

/** GET + JSON parse with the shared retry/backoff. Returns null on any failure. */
async function vibGet<T>(path: string, env: Env): Promise<T | null> {
  const res = await rateLimiter.schedule(() =>
    // `label` keeps retry/error logs prefixed `[viberate]` — the shared helper
    // otherwise defaults to `[reccobeats]` and would misattribute failures.
    fetchWithRetry(
      `${VIBERATE_BASE}${path}`,
      { method: "GET", headers: headers(env) },
      {
        label: "viberate",
      },
    ),
  );
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    console.error(`[viberate] non-JSON response for ${path}`);
    return null;
  }
}

function trendingCountry(env: Env): string {
  // Zod fills the default only when the key is ABSENT; an explicitly-empty
  // `VIBERATE_TRENDING_COUNTRY=` still reaches the `|| DEFAULT` fallback.
  return env.VIBERATE_TRENDING_COUNTRY.trim() || DEFAULT_TRENDING_COUNTRY;
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

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Primary-artist-first credit string from the artists array. */
function joinArtists(artists: TrendingArtist[] | null | undefined): string {
  if (!Array.isArray(artists)) return "";
  return artists
    .map((a) => (typeof a?.name === "string" ? a.name.trim() : ""))
    .filter((n) => n.length > 0)
    .join(", ");
}

function toCandidate(item: TrendingItem, country: string): RawCandidate | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (title.length === 0) return null;
  const isrc = normalizeIsrc(item.isrc);
  const artist = joinArtists(item.artists);
  // Unresolvable junk: no ISRC AND no artist means neither ISRC nor fuzzy
  // (artist, title) resolution can place it. Drop rather than insert an orphan.
  if (!isrc && artist.length === 0) return null;
  const trackId =
    typeof item.track_id === "string" && item.track_id.trim().length > 0
      ? item.track_id.trim()
      : null;
  const velocity: ViberateVelocity = {
    provider: "viberate",
    country,
    sort: TRENDING_SORT,
    streams1d: num(item.streams_1d),
    streams1dPct: num(item.streams_1d_pct),
    rank: num(item.ranks?.rank),
    rankDiff: num(item.ranks?.rank_diff),
  };
  return {
    source: "viberate",
    // The Spotify-trending endpoint keys rows by Spotify track id; fall back to
    // ISRC (then artist::title) so `track_source` always has a stable id.
    sourceTrackId: trackId ?? isrc ?? `${artist}::${title}`,
    isrc,
    // This IS Spotify's chart: `track_id` is a Spotify track id, so set it
    // directly — `resolveSpotifyId` keeps it and ReccoBeats keys off it.
    spotifyId: trackId,
    title,
    artist,
    album: null,
    releaseYear: parseReleaseYear(item.release_date),
    // Trending rows carry no duration; ReccoBeats/Spotify fill it downstream.
    durationMs: null,
    // Trending rows carry no genre (the search/chart endpoints do); the
    // enrichment layer (Last.fm/MB/Discogs) supplies genres.
    genres: [],
    // Keep the raw row so the real field shape stays inspectable on the first
    // live run (the verification aid the docs couldn't give us).
    rawPayload: { velocity, raw: item },
  };
}

async function pullTrending(limit: number, env: Env): Promise<RawCandidate[]> {
  const country = trendingCountry(env);
  const rows = Math.max(1, Math.min(limit, MAX_TRENDING_ROWS));
  const qs = new URLSearchParams({
    country,
    sort: TRENDING_SORT,
    order: TRENDING_ORDER,
    offset: "0",
    limit: String(rows),
  });
  const data = await vibGet<TrendingResponse>(
    `/track/trending/spotify/country?${qs.toString()}`,
    env,
  );
  const items = Array.isArray(data?.data) ? data.data : [];
  const out: RawCandidate[] = [];
  // Defensive cap: we ask for `rows` via the `limit` param, but don't trust the
  // provider to honour it — slice so a server that over-delivers can't blow past
  // MAX_TRENDING_ROWS into the surfacing pool.
  for (const item of items.slice(0, rows)) {
    const candidate = toCandidate(item, country);
    if (candidate) out.push(candidate);
  }
  return out;
}

/** Coerce caller-supplied limit to a positive integer in [1, MAX_TRENDING_ROWS]. */
function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(raw), MAX_TRENDING_ROWS));
}

export const viberateAdapter: SourceAdapter = {
  id: "viberate",
  isPaid: true,
  isAvailable(env) {
    return env.VIBERATE_API_KEY.length > 0;
  },
  async pullCandidates(params, env) {
    // Guard BEFORE any network call so the no-credentials path never hits the
    // wire (and an empty Access-Key never leaves the process).
    if (env.VIBERATE_API_KEY.length === 0) return [];
    // Viberate's signal is the trending chart — `similar`/`search` don't map
    // onto it and degrade to an empty pool (the pipeline only calls trend
    // adapters in `trending` mode; see pipeline-steps.ts).
    if (params.mode !== "trending") return [];
    try {
      return await pullTrending(clampLimit(params.limit), env);
    } catch (err) {
      console.error("[viberate] pullCandidates threw — degrading to []", err);
      return [];
    }
  },
};
