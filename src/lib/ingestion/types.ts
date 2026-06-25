import type { sourceKindEnum } from "@/db/schema";

export type SourceId = (typeof sourceKindEnum.enumValues)[number];

export type PullMode = "trending" | "similar" | "search" | "explore";

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

/**
 * LAB-40 — new-direction discovery: pull top tracks for genres OUTSIDE the
 * user's current buckets (the explore counterpart to the taste-seeded `similar`
 * exploit pull). The pipeline computes the genre batch (slots not represented in
 * any bucket, rotated across runs) and passes it; each explore-capable adapter
 * maps a genre name to its own primitive — Last.fm `tag.getTopTracks`, Spotify
 * `genre:"…"` search. Adapters that can't do genre-scoped discovery return `[]`
 * (Constraint #1), exactly as they do for `similar`.
 */
export type ExplorePullParams = PullParamsBase & {
  mode: "explore";
  /** Genre/tag names to explore — a slice of GENRE_SLOTS absent from the user's buckets. */
  genres: readonly string[];
};

export type PullParams =
  | SearchPullParams
  | TrendingPullParams
  | SimilarPullParams
  | ExplorePullParams;

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
  genres: string[];
  rawPayload: unknown;
};
