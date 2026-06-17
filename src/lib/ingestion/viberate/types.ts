/**
 * Viberate social-breakout discovery engine (LAB-90) — shared types.
 *
 * Response shapes verified live during the LAB-90 spike (2026-06-13) via
 * `scripts/lab-viberate-engine-probe.ts`. The engine pulls a broad pool that
 * LEADS Spotify (YouTube trending + the cross-platform composite chart, sorted
 * by Shazam/SoundCloud), scores each candidate by its breakout gap — high
 * social/alternative momentum while Spotify presence is still low — and
 * composes the per-run pull toward that gap so we surface tracks BEFORE they
 * are mainstream, instead of Spotify's short tail.
 */

/** Which broad-pool feed a pooled row came from. */
export type ViberateFeed = "spotify-trending" | "youtube-trending" | "composite-chart";

/** Artist credit as it appears across Viberate track endpoints. */
export type ViberateArtist = { uuid?: string; name?: string; slug?: string };

// ---------------------------------------------------------------------------
// Feed response rows (Stage 1 — broad pool)
// ---------------------------------------------------------------------------

/** Row of `GET /track/trending/spotify/country` (the LAB-88 feed). */
export type SpotifyTrendingItem = {
  track_id?: string;
  title?: string;
  isrc?: string | null;
  release_date?: string | null;
  artists?: ViberateArtist[] | null;
  streams_1d?: number;
  streams_1d_pct?: number;
  ranks?: { rank?: number; rank_diff?: number } | null;
};

/** Row of `GET /track/trending/youtube/country`. No ISRC / no track uuid. */
export type YoutubeTrendingItem = {
  /** Viberate-namespaced id (e.g. "G:wQoqBalpbtc") — NOT resolvable directly. */
  track_id?: string;
  /** YouTube video id — the resolution key (`/track/by-channel/youtube/{id}`). */
  youtube_id?: string;
  title?: string;
  release_date?: string | null;
  artists?: ViberateArtist[] | null;
  views_1w?: number;
  views_1w_prev?: number;
  views_1w_pct?: number;
  views_1m?: number;
  views_1m_pct?: number;
  ranks?: { rank?: number; rank_diff?: number } | null;
};

/** Per-timeframe metric buckets carried inline on composite-chart rows. */
export type ChartTimeframes = {
  "1w"?: number | string | null;
  "1m"?: number | string | null;
  "3m"?: number | string | null;
  "12m"?: number | string | null;
  total?: number | string | null;
};

/**
 * Row of `GET /track/viberate/chart`. Keyed by Viberate track uuid and — the
 * key win — carries inline `charts` with BOTH the social signal (shazam) and
 * Spotify maturity (spotify.streams), so the breakout gap is computable from
 * the chart call itself (no per-track hop).
 */
export type CompositeChartItem = {
  uuid?: string;
  name?: string;
  release_date?: string | null;
  artists?: ViberateArtist[] | null;
  genre?: { id?: number; name?: string; slug?: string } | null;
  charts?: {
    shazam?: { shazams?: ChartTimeframes } | null;
    soundcloud?: { plays?: ChartTimeframes } | null;
    youtube?: { views?: ChartTimeframes } | null;
    spotify?: { streams?: ChartTimeframes } | null;
    viberate?: { overall?: ChartTimeframes } | null;
  } | null;
};

// ---------------------------------------------------------------------------
// Resolution responses (Stage 2)
// ---------------------------------------------------------------------------

/** `GET /track/by-channel/youtube/{youtube_id}` and `GET /track/{uuid}/details`. */
export type ViberateTrackDetails = {
  uuid?: string;
  name?: string;
  isrc?: string | null;
  isrc_cluster?: string[] | null;
  release_date?: string | null;
  genre?: { id?: number; name?: string; slug?: string } | null;
  subgenres?: { id?: number; name?: string; slug?: string }[] | null;
  artists?: ViberateArtist[] | null;
};

/**
 * `GET /track/{uuid}/viberate/stats-alltime` — compact cross-platform snapshot
 * used as the Spotify-maturity input for feeds that lack inline charts.
 */
export type ViberateStatsAlltime = {
  "spotify-streams"?: number | null;
  "spotify-active_playlists"?: number | null;
  "spotify-playlist_reach"?: number | null;
  "youtube-views"?: number | null;
  "soundcloud-plays"?: number | null;
  "shazam-shazams"?: number | null;
  "beatport-performance_points"?: number | null;
};

// ---------------------------------------------------------------------------
// Internal pipeline shapes
// ---------------------------------------------------------------------------

/**
 * Raw per-platform momentum/maturity signals gathered for a candidate. All
 * optional — different feeds populate different subsets. Numbers are the raw
 * provider values; normalization happens in `breakout.ts`.
 */
export type BreakoutSignals = {
  /** Recent (weekly) Shazam count — the social leading indicator. */
  shazam1w?: number | null;
  /** Recent (weekly) SoundCloud plays. */
  soundcloud1w?: number | null;
  /** YouTube weekly views + week-over-week %. */
  youtubeViews1w?: number | null;
  youtubeViewsPct?: number | null;
  /** Intra-Spotify daily surge % (spotify-trending feed's rising proxy). */
  spotifySurgePct?: number | null;
  // Spotify MATURITY — higher means more mainstream (the thing we discount).
  // Kept as separate timeframes so each is scored against its own anchor: the
  // spotify-trending feed reports DAILY streams, the composite chart WEEKLY.
  /** Daily Spotify streams (spotify-trending feed). */
  spotifyStreamsDay?: number | null;
  /** Weekly Spotify streams (composite-chart `charts.spotify.streams.1w`). */
  spotifyStreamsWeek?: number | null;
  /** All-time Spotify streams (composite total / stats-alltime). */
  spotifyStreamsTotal?: number | null;
  spotifyPlaylistReach?: number | null;
};

/**
 * Common row produced by the pool stage, one per pooled candidate, carrying
 * everything needed to score it for free and to resolve it later.
 */
export type PooledRow = {
  feed: ViberateFeed;
  title: string;
  artist: string;
  artists: ViberateArtist[];
  releaseYear: number | null;
  /** Spotify track id when the feed provides it directly (spotify-trending). */
  spotifyId: string | null;
  /** ISRC when the feed provides it directly (spotify-trending). */
  isrc: string | null;
  /** Viberate track uuid when present (composite-chart). */
  uuid: string | null;
  /** YouTube video id, the resolution key for youtube-trending rows. */
  youtubeId: string | null;
  genres: string[];
  signals: BreakoutSignals;
  /** The verbatim feed row, kept for audit on `track_source.raw_payload`. */
  raw: unknown;
};

/**
 * The typed breakout signal persisted on `track_source.raw_payload`. The eval
 * substrate for source quality and the input the PR-2 ranker down-weight reads.
 */
export type ViberateBreakout = {
  provider: "viberate";
  feed: ViberateFeed;
  /** breakout = socialMomentum − balance·spotifyMaturity, clamped to [0,1]. */
  score: number;
  /** Normalized social/alternative momentum in [0,1]. */
  socialMomentum: number;
  /** Normalized Spotify maturity in [0,1] (higher = more mainstream). */
  spotifyMaturity: number;
  /** The raw provider signals the score was computed from. */
  signals: BreakoutSignals;
};
