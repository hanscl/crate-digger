import { z } from "zod";

/**
 * Constraint #8: the taste profile is portable as JSON. This module defines
 * the wire format. Bumping the major version is a breaking change; importers
 * accept only versions they know how to parse.
 *
 * Shape choices:
 *
 *   - Tracks identified structurally (isrc + spotify_id + title + artist) so
 *     a wiped DB can rebuild the catalog without remembering serial IDs. Two
 *     deploys of the same install round-trip; cross-install merges still work
 *     when ISRCs line up.
 *   - Bucket centroids and feature_stats are NOT exported. They're derivable
 *     from members + audio features and would otherwise drift across schema
 *     bumps. Import recomputes them.
 *   - Ratings carry the original `ratedAt` and a track reference; the
 *     surface_event chain is intentionally dropped — a wiped DB has no
 *     surface history to attach to. Imported ratings attribute to the active
 *     broad version (cold-start path of `ingestRating`, Phase 5).
 */

export const TASTE_TRACK_REF_SCHEMA = z.object({
  isrc: z.string().nullable(),
  spotifyId: z.string().nullable(),
  title: z.string().min(1),
  artist: z.string().min(1),
  album: z.string().nullable().optional(),
  genres: z.array(z.string()).default([]),
});

export type TasteTrackRef = z.infer<typeof TASTE_TRACK_REF_SCHEMA>;

export const TASTE_BUCKET_SCHEMA = z.object({
  name: z.string().min(1),
  color: z.string().nullable(),
  primaryGenre: z.string().nullable(),
  isColdStartSeed: z.boolean().default(false),
  members: z.array(TASTE_TRACK_REF_SCHEMA),
});

export const TASTE_RATING_SCHEMA = z.object({
  decision: z.enum(["keep", "dislike", "defer", "neutral"]),
  ratedAt: z.string(),
  track: TASTE_TRACK_REF_SCHEMA,
});

export const TASTE_CONFIG_SCHEMA = z.object({
  novelty: z.number().min(0).max(1),
  sourceMix: z.number().min(0).max(1),
  queueCeiling: z.number().int().nonnegative(),
  // LAB-53 — per-ranker quality bars travel with the taste profile. Optional so
  // pre-LAB-53 exports (which lack them) still import: importTaste's upsert
  // falls back to the app_config column defaults (0.7 / 0.5) for absent fields.
  refillQualityBar: z.number().min(0).max(1).optional(),
  broadQualityBar: z.number().min(0).max(1).optional(),
  spawnThreshold: z.number().min(0).max(1),
  refillLambda: z.number().min(0),
  mergeThreshold: z.number().min(0).max(1),
  splitDislikeRate: z.number().min(0).max(1),
  // LAB-51 — pull throttle travels with the taste profile (Constraint #8).
  trendingLimitPerSource: z.number().int().nonnegative(),
  similarLimitPerSource: z.number().int().nonnegative(),
  similarSeedBuckets: z.number().int().nonnegative(),
});

export const TASTE_EXPORT_SCHEMA = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  config: TASTE_CONFIG_SCHEMA.optional(),
  buckets: z.array(TASTE_BUCKET_SCHEMA),
  ratings: z.array(TASTE_RATING_SCHEMA),
});

export type TasteExport = z.infer<typeof TASTE_EXPORT_SCHEMA>;
export type TasteBucket = z.infer<typeof TASTE_BUCKET_SCHEMA>;
export type TasteRating = z.infer<typeof TASTE_RATING_SCHEMA>;
