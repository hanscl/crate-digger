import type { sourceKindEnum } from "@/db/schema";

export type SourceId = (typeof sourceKindEnum.enumValues)[number];

export type PullMode = "trending" | "similar" | "search";

type PullParamsBase = {
  /** Hard upper bound. Adapter may return fewer. */
  limit?: number;
};

/** Free-text search. */
export type SearchPullParams = PullParamsBase & {
  mode: "search";
  query: string;
};

/** Top/recent chart. */
export type TrendingPullParams = PullParamsBase & {
  mode: "trending";
  /**
   * LAB-84 — Spotify playlist IDs to ingest, read ONLY by the playlist-seed
   * adapter (other adapters ignore it). The pipeline threads the configured
   * `app_config.sources.tiktokPlaylistSeed.playlistIds` through here; absent or
   * empty ⇒ the adapter returns [].
   */
  playlistIds?: readonly string[];
};

/**
 * "More like this." Two valid shapes:
 *  - adapter-native seed id (e.g. Spotify track id), or
 *  - artist + title pair (Last.fm-style).
 */
export type SimilarPullParams = PullParamsBase &
  (
    | { mode: "similar"; seedSourceId: string; seedArtist?: string; seedTrack?: string }
    | { mode: "similar"; seedSourceId?: undefined; seedArtist: string; seedTrack: string }
  );

export type PullParams = SearchPullParams | TrendingPullParams | SimilarPullParams;

/**
 * Source-agnostic shape produced by every adapter. The enrichment layer
 * dedupes these by ISRC (with fuzzy fallback) before they become `track` rows.
 */
export type RawCandidate = {
  source: SourceId;
  sourceTrackId: string;
  isrc: string | null;
  spotifyId: string | null;
  title: string;
  artist: string;
  album: string | null;
  releaseYear: number | null;
  durationMs: number | null;
  /**
   * LAB-84 — Spotify popularity (0–100), when the source exposes it (Spotify +
   * playlist-seed). null for sources that don't (Last.fm/Viberate/TikTok).
   * Persisted widen-only into `track.spotify_popularity`; feeds the explore-lane
   * inverse-popularity surfacing bias.
   */
  popularity: number | null;
  genres: string[];
  rawPayload: unknown;
};
