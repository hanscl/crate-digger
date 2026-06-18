/**
 * Chartmetric social-breakout discovery engine (LAB-117) — shared types.
 *
 * Response shapes verified live during the LAB-117 spike (2026-06-17) via
 * `scripts/lab-chartmetric-engine-probe.ts`. Same objective as the Viberate
 * engine (LAB-90): pull a broad pool that LEADS Spotify (Shazam / TikTok /
 * SoundCloud charts), score each candidate by its breakout gap — high social
 * momentum while Spotify maturity is still low — and compose the per-run pull
 * toward that gap so we surface tracks BEFORE they go mainstream.
 *
 * The shape differs from Viberate in two ways, both favourable: ISRC + the
 * Chartmetric track id (`cm_track`) ride INLINE on every chart row (no
 * resolution hop to dedup), and `spotify_popularity` rides inline too (a coarse
 * maturity proxy for free). The continuous maturity (`sp_playlist_total_reach`,
 * `sp_streams`) comes from ONE per-shortlisted-row `/api/track/{cm_track}` call.
 */

/**
 * Which broad-pool feed a pooled row came from. `applemusic` is a forward-looking
 * stub: it is NOT in `FEEDS` (config.ts), so no chart row ever carries it today.
 * It rides here to keep `pool.ts#feedSignals` switch-exhaustive and to pre-seed a
 * `FEED_WEIGHTS` default for when an Apple Music chart feed is wired up.
 */
export type ChartmetricFeedId = "spotify" | "shazam" | "tiktok" | "soundcloud" | "applemusic";

/** A feed's role in the breakout gap: a social leading indicator vs Spotify maturity. */
export type ChartmetricFeedKind = "social" | "maturity";

/** Daily charts lag ~1–3 days; weekly ~3–10. Drives the client's date ladder. */
export type ChartCadence = "daily" | "weekly";

/** A configured chart feed: its endpoint, cadence, query, and selection weight. */
export type ChartmetricFeed = {
  id: ChartmetricFeedId;
  kind: ChartmetricFeedKind;
  /** Endpoint path, e.g. `/api/charts/tiktok/tracks`. */
  path: string;
  cadence: ChartCadence;
  /** Per-feed selection weight (composite/social > spotify), like Viberate's FEED_WEIGHTS. */
  weight: number;
  /** Build the (verified) query params for a country + chart date. Charts reject limit/offset. */
  query: (country: string, date: string) => Record<string, string>;
};

/**
 * A Chartmetric chart row. Only the breakout-relevant fields are typed; the
 * verbatim row is kept on `PooledRow.raw`. Different charts populate different
 * social fields (Shazam → `num_of_shazams`, TikTok → `weekly_posts`, …), but
 * `isrc` / `cm_track` / `spotify_popularity` / `rank` / `velocity` are common.
 */
export type ChartRow = {
  id?: number | string;
  cm_track?: number | string;
  isrc?: string | null;
  name?: string;
  artist_names?: string[] | string | null;
  artists?: { name?: string }[] | null;
  release_dates?: string[] | null;
  release_date?: string | null;
  /** Spotify track id — inline on the Spotify regional chart only. */
  spotify_track_id?: string | null;
  /** 0–100 mainstream maturity proxy — inline on EVERY chart row. */
  spotify_popularity?: number | null;
  rank?: number | null;
  pre_rank?: number | null;
  /** Chartmetric's per-row momentum (rank-movement rate); the "rising" signal. */
  velocity?: number | null;
  // Per-platform social counts (whichever chart the row came from):
  num_of_shazams?: number | null;
  weekly_posts?: number | null;
  /** Spotify regional daily streams (maturity). */
  current_plays?: number | null;
};

/**
 * `GET /api/track/{cm_track}` — the one optional resolve hop. `cm_statistics`
 * is the cross-platform snapshot (richer than Viberate's `stats-alltime`):
 * Spotify maturity + social counts in a single call. `genres` backfills genre.
 */
export type TrackDetails = {
  id?: number | string;
  isrc?: string | null;
  release_date?: string | null;
  genres?: { id?: number; name?: string }[] | null;
  cm_statistics?: {
    sp_playlist_total_reach?: number | null;
    sp_streams?: number | null;
    sp_popularity?: number | null;
    num_sp_playlists?: number | null;
    shazam_counts?: number | null;
    num_tt_videos?: number | null;
  } | null;
};

/**
 * Raw per-platform momentum/maturity signals gathered for a candidate. All
 * optional — different feeds populate different subsets. Numbers are raw
 * provider values; normalization happens in `breakout.ts`.
 */
export type BreakoutSignals = {
  // --- social momentum (recent, the leading indicator) ---
  /** Weekly Shazam count (Shazam chart `num_of_shazams`). */
  shazamCount?: number | null;
  /** Weekly TikTok UGC posts (TikTok chart `weekly_posts`; or `num_tt_videos` from stats). */
  tiktokPosts?: number | null;
  /** Weekly SoundCloud plays (SoundCloud chart). */
  soundcloudPlays?: number | null;
  /** Chart-row momentum (`velocity`) — the rising-rate proxy for any feed. */
  chartVelocity?: number | null;
  // --- Spotify maturity (higher = more mainstream; the thing we discount) ---
  /** Inline 0–100 popularity (every chart row). */
  spotifyPopularity?: number | null;
  /** Daily Spotify streams (Spotify regional `current_plays`). */
  spotifyDailyStreams?: number | null;
  /** Spotify playlist reach (`cm_statistics.sp_playlist_total_reach`, resolve hop). */
  spotifyPlaylistReach?: number | null;
  /** All-time Spotify streams (`cm_statistics.sp_streams`, resolve hop). */
  spotifyTotalStreams?: number | null;
};

/** Common row produced by the pool stage, one per pooled candidate. */
export type PooledRow = {
  feed: ChartmetricFeedId;
  title: string;
  artist: string;
  releaseYear: number | null;
  /** Chartmetric track id — inline on every chart row; the resolve + stable-id key. */
  cmTrack: string | null;
  /** ISRC — inline on every chart row. */
  isrc: string | null;
  /** Spotify track id — inline on the Spotify chart; null elsewhere (backfilled downstream). */
  spotifyId: string | null;
  genres: string[];
  signals: BreakoutSignals;
  /** The verbatim chart row, kept for audit on `track_source.raw_payload`. */
  raw: unknown;
};

/**
 * The typed breakout signal persisted on `track_source.raw_payload`. The eval
 * substrate for source quality (parallel to Viberate's `ViberateBreakout`).
 */
export type ChartmetricBreakout = {
  provider: "chartmetric";
  feed: ChartmetricFeedId;
  /** breakout = socialMomentum − balance·spotifyMaturity, clamped to [0,1]. */
  score: number;
  /** Normalized social/alternative momentum in [0,1]. */
  socialMomentum: number;
  /** Normalized Spotify maturity in [0,1] (higher = more mainstream). */
  spotifyMaturity: number;
  /** The raw provider signals the score was computed from. */
  signals: BreakoutSignals;
};
