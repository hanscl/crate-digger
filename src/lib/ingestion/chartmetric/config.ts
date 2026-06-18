/**
 * Chartmetric engine tuning (LAB-117). Module constants for v1 — no new `Env`
 * fields beyond the existing `CHARTMETRIC_REFRESH_TOKEN` / chart territory, and
 * no schema migration. Promote to env / app_config later if these need to be
 * operator-tunable at runtime.
 */

import type { ChartCadence, ChartmetricFeed } from "./types";

/**
 * The broad-pool feeds. Shazam + SoundCloud skew far less mainstream than
 * stream counts — the underground/leading breakout indicators (weight 1.0).
 * TikTok UGC velocity is close behind (0.9). The Spotify regional chart IS
 * Spotify-native, so it's de-emphasised (0.45, like Viberate's spotify-trending)
 * to keep the pool from collapsing back into the Spotify short tail — but it's
 * kept, both for its own fast-risers and as an inline maturity reference.
 *
 * Query params are exactly what the live API accepts (verified in the spike):
 * charts reject `limit`/`offset` (we slice client-side) and each platform has a
 * different required-param set — hence per-feed query builders.
 */
export const FEEDS: readonly ChartmetricFeed[] = [
  {
    id: "shazam",
    kind: "social",
    path: "/api/charts/shazam",
    cadence: "daily",
    weight: 1.0,
    query: (country, date) => ({ country_code: country, date }),
  },
  {
    id: "soundcloud",
    kind: "social",
    path: "/api/charts/soundcloud",
    cadence: "weekly",
    weight: 1.0,
    // `kind=trending` is SoundCloud's breakout chart; `genre` is required and
    // `all-music` is the cross-genre rollup (one of the API's allowed slugs).
    //
    // LAB-118: NO `interval`. The live probe found the SoundCloud endpoint
    // REJECTS `interval` (HTTP 400 `'interval' is not allowed`, same as Shazam) —
    // that 400 (not the date ladder) was what failed the feed on every run, so it
    // never even reached a date rung. Dropping it makes the endpoint reachable
    // (HTTP 200) and the weekly date ladder actually run. The chart can still be
    // legitimately empty (probed empty across dates/genres/countries on
    // 2026-06-18); that's a quiet reachable-empty `[]`, not a degrade.
    query: (country, date) => ({
      country_code: country,
      kind: "trending",
      genre: "all-music",
      date,
    }),
  },
  {
    id: "tiktok",
    kind: "social",
    path: "/api/charts/tiktok/tracks",
    cadence: "weekly",
    weight: 0.9,
    // The TikTok tracks chart is global/weekly; it rejects country_code.
    query: (_country, date) => ({ interval: "weekly", date }),
  },
  {
    id: "spotify",
    kind: "maturity",
    path: "/api/charts/spotify",
    cadence: "daily",
    weight: 0.45,
    query: (country, date) => ({
      type: "regional",
      country_code: country,
      interval: "daily",
      date,
    }),
  },
];

/**
 * Chartmetric charts require a `date` and lag by a few days, with no reliable
 * "latest" flag — so per cadence we walk a small descending date ladder and
 * take the first date that returns rows. A miss costs one (cheap, metered) call;
 * the common case hits on the first rung.
 */
export const DATE_LADDER: Record<ChartCadence, readonly number[]> = {
  daily: [1, 2, 3, 4],
  weekly: [4, 7, 10],
};

/** Rows to keep per feed for scoring (charts return 50–200; we slice). */
export const POOL_ROWS_PER_FEED = 50;

/** Default returned count when the caller gives no (or a junk) limit. */
export const DEFAULT_RETURN = 12;

/**
 * Hard ceiling on candidates returned per run. Each returned candidate may cost
 * one `/api/track/{cm_track}` resolve call (only when it lacks inline Spotify
 * maturity), so a full run is ~4 chart calls + ≤MAX_RETURN resolves — still
 * fractions of a cent on metered billing. The daily throttle is far smaller.
 */
export const MAX_RETURN = 50;
