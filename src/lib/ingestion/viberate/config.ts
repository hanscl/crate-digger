/**
 * Viberate engine tuning (LAB-90). Kept as module constants for v1 — no new
 * `Env` fields (which would ripple through every full-`Env` test fixture) and
 * no schema migration. Promote to env / app_config in a later pass if these
 * need to be operator-tunable at runtime. The Spotify-feed country still comes
 * from the existing `VIBERATE_TRENDING_COUNTRY` env var.
 */

/**
 * YouTube-trending territories to sweep. CURTAILED to US-only (LAB-118).
 *
 * Live probe (lab-viberate-engine-probe + a fresh-row sweep, 2026-06-18):
 * YouTube rows resolve only via `/track/by-channel/youtube/{id}`, which 404s for
 * ~2 of every 3 rows (resolved=4, failed=8 across US/GB/DE). The row's only other
 * id — the Viberate-native `track_id` ("G:…") — is NOT resolvable: both
 * `/track/{track_id}/details` and `/track/{track_id}/links` return HTTP 400. So
 * the majority of YouTube rows can't get an ISRC or Spotify-maturity signal and
 * sit at the imputed UNKNOWN_MATURITY discount, crowding the shortlist out from
 * the fully-resolvable composite (Shazam/SoundCloud) + Spotify feeds. Sweeping 3
 * territories tripled that unresolvable footprint (3 chart pulls vs 1 each for
 * the others). Dropping to US-only is the smallest change that meaningfully
 * rebalances the pull toward resolvable feeds while keeping YouTube's
 * leading-indicator signal in play; the 404/miss path stays graceful (the row is
 * not dropped — it's still scored on its free inline YouTube momentum).
 */
export const YOUTUBE_COUNTRIES: readonly string[] = ["US"];

/**
 * Composite-chart lead signals to pull. Shazam + SoundCloud skew far less
 * mainstream than stream counts — the leading/underground breakout indicators.
 */
export const COMPOSITE_SORTS: readonly string[] = ["shazam-shazams", "soundcloud-plays"];

/** Composite-chart window — recent week, to catch what's surging now. */
export const COMPOSITE_TIMEFRAME = "1w";

/**
 * Rows to pull per feed for scoring (cheap — one chart call each). Capped at 20:
 * the trial/entry tier rejects `limit > 20` on every feed endpoint with HTTP 400
 * (verified live — limit=20 → 200, limit=25 → 400), which silently emptied the
 * pool. Raise (or paginate via offset) only against a tier whose per-request cap
 * is confirmed higher.
 */
export const POOL_ROWS_PER_FEED = 20;

/**
 * Hard ceiling on candidates returned per run, regardless of the throttle limit.
 * Note: each returned candidate costs 1–2 Viberate calls to resolve, so a full
 * 50-candidate run can approach ~106 calls — paced under the ~60/window limit by
 * the client's rate limiter + 429 backoff. The daily throttle is far smaller.
 */
export const MAX_RETURN = 50;

/** Default returned count when the caller gives no (or a junk) limit. */
export const DEFAULT_RETURN = 12;

// TikTok is deliberately not wired in v1: per-track TikTok velocity lives only
// under `/requested-track/{uuid}/tiktok/*`, which REGISTERS the track (consumes
// plan quota) and was not exercised during the spike. Enabling it — including
// any budget cap — is tracked in LAB-91, to be added when the flow is verified.
