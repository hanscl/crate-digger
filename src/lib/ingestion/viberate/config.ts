/**
 * Viberate engine tuning (LAB-90). Kept as module constants for v1 — no new
 * `Env` fields (which would ripple through every full-`Env` test fixture) and
 * no schema migration. Promote to env / app_config in a later pass if these
 * need to be operator-tunable at runtime. The Spotify-feed country still comes
 * from the existing `VIBERATE_TRENDING_COUNTRY` env var.
 */

/** YouTube-trending territories to sweep (Hans: DE/GB/US). */
export const YOUTUBE_COUNTRIES: readonly string[] = ["US", "GB", "DE"];

/**
 * Composite-chart lead signals to pull. Shazam + SoundCloud skew far less
 * mainstream than stream counts — the leading/underground breakout indicators.
 */
export const COMPOSITE_SORTS: readonly string[] = ["shazam-shazams", "soundcloud-plays"];

/** Composite-chart window — recent week, to catch what's surging now. */
export const COMPOSITE_TIMEFRAME = "1w";

/** Rows to pull per feed for scoring (cheap — one chart call each). */
export const POOL_ROWS_PER_FEED = 50;

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
