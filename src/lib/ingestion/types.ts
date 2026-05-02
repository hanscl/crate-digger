import type { sourceKindEnum } from "@/db/schema";

export type SourceId = (typeof sourceKindEnum.enumValues)[number];

export type PullMode = "trending" | "similar" | "search";

export type PullParams = {
  mode: PullMode;
  /** Free-text query. Required when `mode === "search"`. */
  query?: string;
  /** Seed artist name (paired with `seedTrack` for `similar`). */
  seedArtist?: string;
  /** Seed track title. */
  seedTrack?: string;
  /** Adapter-native seed id (e.g. Spotify track id) for `similar`. */
  seedSourceId?: string;
  /** Hard upper bound. Adapter may return fewer. */
  limit?: number;
};

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
