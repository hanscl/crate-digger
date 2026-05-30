import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const EMBEDDING_DIM = 64;

export const ratingDecisionEnum = pgEnum("rating_decision", [
  "keep",
  "dislike",
  "defer",
  "neutral",
]);

export const rankerKindEnum = pgEnum("ranker_kind", ["refill", "broad"]);

export const modelVersionKindEnum = pgEnum("model_version_kind", ["refill", "broad"]);

export const recommendationKindEnum = pgEnum("bucket_recommendation_kind", ["merge", "split"]);

export const recommendationStatusEnum = pgEnum("bucket_recommendation_status", [
  "pending",
  "accepted",
  "dismissed",
]);

export const sourceKindEnum = pgEnum("source_kind", ["spotify", "lastfm", "viberate"]);

export const track = pgTable(
  "track",
  {
    id: serial("id").primaryKey(),
    isrc: text("isrc"),
    spotifyId: text("spotify_id"),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    album: text("album"),
    releaseYear: integer("release_year"),
    durationMs: integer("duration_ms"),
    audioFeatures: jsonb("audio_features").$type<AudioFeatures | null>(),
    genres: text("genres")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    primaryGenre: text("primary_genre"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    // MusicBrainz recording MBID. Populated lazily by the MusicBrainz
    // enricher (via Last.fm `track.getInfo` lookup) so subsequent runs can
    // skip resolution.
    mbid: text("mbid"),
    // Per-source enrichment idempotency. Each genre source ("lastfm",
    // "musicbrainz", "discogs") appends its id after a completed pass —
    // whether tags were returned or not. An entry means "tried; do not
    // retry". Empty array = never enriched for genres.
    genreSourcesProcessed: text("genre_sources_processed")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("track_isrc_idx").on(t.isrc),
    uniqueIndex("track_spotify_id_idx").on(t.spotifyId),
    index("track_artist_title_idx").on(t.artist, t.title),
    index("track_embedding_hnsw_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
    index("track_mbid_idx")
      .on(t.mbid)
      .where(sql`${t.mbid} IS NOT NULL`),
    index("track_genre_sources_processed_idx").using("gin", t.genreSourcesProcessed),
  ],
);

export const trackSource = pgTable(
  "track_source",
  {
    id: serial("id").primaryKey(),
    trackId: integer("track_id")
      .notNull()
      .references(() => track.id, { onDelete: "cascade" }),
    source: sourceKindEnum("source").notNull(),
    sourceTrackId: text("source_track_id").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
    rawPayload: jsonb("raw_payload").$type<unknown>(),
  },
  (t) => [
    uniqueIndex("track_source_unique_idx").on(t.source, t.sourceTrackId),
    index("track_source_track_id_idx").on(t.trackId),
  ],
);

export const bucket = pgTable(
  "bucket",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color"),
    centroid: vector("centroid", { dimensions: EMBEDDING_DIM }).notNull(),
    featureStats: jsonb("feature_stats").$type<FeatureStats>().notNull(),
    memberCount: integer("member_count").notNull().default(0),
    dislikeCount: integer("dislike_count").notNull().default(0),
    isColdStartSeed: boolean("is_cold_start_seed").notNull().default(false),
    primaryGenre: text("primary_genre"),
    // LAB-25 drift-tracking: member count and centroid snapshot at the moment
    // of the last successful agent naming. Null on rows that still carry the
    // deterministic " (auto)" placeholder — the rename pass treats null as
    // "never named, eligible at N ≥ 3."
    lastNamedAtCount: integer("last_named_at_count"),
    lastNamedCentroid: vector("last_named_centroid", { dimensions: EMBEDDING_DIM }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bucket_centroid_hnsw_idx")
      .using("hnsw", t.centroid.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
    index("bucket_primary_genre_idx").on(t.primaryGenre),
  ],
);

export const bucketMember = pgTable(
  "bucket_member",
  {
    id: serial("id").primaryKey(),
    bucketId: integer("bucket_id")
      .notNull()
      .references(() => bucket.id, { onDelete: "cascade" }),
    trackId: integer("track_id")
      .notNull()
      .references(() => track.id, { onDelete: "cascade" }),
    similarityAtJoin: doublePrecision("similarity_at_join"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Enforces one-track-one-bucket at the schema level. Two concurrent
    // `assignTrack` calls for the same track both probe "no membership"
    // and proceed; the loser's `bucket_member` insert hits this constraint,
    // its transaction rolls back (including any new bucket it spawned),
    // and the caller retries — finding the winner's row on the next probe.
    uniqueIndex("bucket_member_track_unique_idx").on(t.trackId),
    uniqueIndex("bucket_member_unique_idx").on(t.bucketId, t.trackId),
  ],
);

export const modelVersion = pgTable(
  "model_version",
  {
    id: serial("id").primaryKey(),
    kind: modelVersionKindEnum("kind").notNull(),
    config: jsonb("config").$type<unknown>().notNull(),
    trainingWindowStart: timestamp("training_window_start", { withTimezone: true }),
    trainingWindowEnd: timestamp("training_window_end", { withTimezone: true }),
    trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
    parentId: integer("parent_id").references((): AnyPgColumn => modelVersion.id, {
      onDelete: "set null",
    }),
    note: text("note"),
  },
  (t) => [index("model_version_kind_trained_idx").on(t.kind, t.trainedAt)],
);

export const surfaceEvent = pgTable(
  "surface_event",
  {
    id: serial("id").primaryKey(),
    trackId: integer("track_id")
      .notNull()
      .references(() => track.id, { onDelete: "cascade" }),
    rankerKind: rankerKindEnum("ranker_kind").notNull(),
    bucketId: integer("bucket_id").references(() => bucket.id, { onDelete: "set null" }),
    modelVersionId: integer("model_version_id")
      .notNull()
      .references(() => modelVersion.id),
    featuresAtDecision: jsonb("features_at_decision").$type<AudioFeatures>().notNull(),
    winnerScore: doublePrecision("winner_score").notNull(),
    candidatePool: jsonb("candidate_pool").$type<CandidatePoolEntry[]>().notNull(),
    surfacedReason: text("surfaced_reason"),
    surfacedAt: timestamp("surfaced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("surface_event_track_idx").on(t.trackId),
    index("surface_event_surfaced_at_idx").on(t.surfacedAt),
    index("surface_event_model_version_idx").on(t.modelVersionId),
  ],
);

export const rating = pgTable(
  "rating",
  {
    id: serial("id").primaryKey(),
    trackId: integer("track_id")
      .notNull()
      .references(() => track.id, { onDelete: "cascade" }),
    decision: ratingDecisionEnum("decision").notNull(),
    modelVersionId: integer("model_version_id")
      .notNull()
      .references(() => modelVersion.id),
    surfaceEventId: integer("surface_event_id").references(() => surfaceEvent.id, {
      onDelete: "set null",
    }),
    ratedAt: timestamp("rated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rating_track_idx").on(t.trackId),
    index("rating_rated_at_idx").on(t.ratedAt),
    index("rating_model_version_idx").on(t.modelVersionId),
  ],
);

export const searchRun = pgTable(
  "search_run",
  {
    id: serial("id").primaryKey(),
    source: sourceKindEnum("source").notNull(),
    params: jsonb("params").$type<unknown>().notNull(),
    countPulled: integer("count_pulled").notNull().default(0),
    countSurfaced: integer("count_surfaced").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [index("search_run_started_at_idx").on(t.startedAt)],
);

export const bucketRecommendation = pgTable(
  "bucket_recommendation",
  {
    id: serial("id").primaryKey(),
    kind: recommendationKindEnum("kind").notNull(),
    bucketIds: integer("bucket_ids").array().notNull(),
    reason: jsonb("reason").$type<unknown>().notNull(),
    status: recommendationStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("bucket_recommendation_status_idx").on(t.status),
    // Race-safe dedupe: the heuristic stores `bucketIds` already sorted
    // ascending, so two concurrent runs both attempting to insert the same
    // (kind, bucketIds) tuple collide on this index. The insert path uses
    // ON CONFLICT DO NOTHING to swallow the collision atomically.
    uniqueIndex("bucket_recommendation_kind_bucket_ids_unique_idx").on(t.kind, t.bucketIds),
  ],
);

export const appConfig = pgTable(
  "app_config",
  {
    id: integer("id").primaryKey().default(1),
    novelty: doublePrecision("novelty").notNull().default(0.5),
    sourceMix: doublePrecision("source_mix").notNull().default(0.5),
    dailySurfaceCap: integer("daily_surface_cap").notNull().default(15),
    queueCeiling: integer("queue_ceiling").notNull().default(50),
    retrainCadence: text("retrain_cadence").notNull().default("daily"),
    spawnThreshold: doublePrecision("spawn_threshold").notNull().default(0.7),
    refillLambda: doublePrecision("refill_lambda").notNull().default(0.3),
    mergeThreshold: doublePrecision("merge_threshold").notNull().default(0.92),
    splitDislikeRate: doublePrecision("split_dislike_rate").notNull().default(0.5),
    sourcesEnabled: jsonb("sources_enabled")
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{"spotify":true,"lastfm":true,"viberate":false,"reccobeats":true}'::jsonb`),
    activeRefillVersionId: integer("active_refill_version_id").references(() => modelVersion.id),
    activeBroadVersionId: integer("active_broad_version_id").references(() => modelVersion.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("app_config_singleton_chk", sql`${t.id} = 1`)],
);

export type AudioFeatures = {
  tempo: number;
  energy: number;
  valence: number;
  danceability: number;
  acousticness: number;
  instrumentalness: number;
};

export type FeatureStats = {
  // Welford running stats per feature key.
  count: number;
  mean: AudioFeatures;
  m2: AudioFeatures;
};

export type CandidatePoolEntry = {
  trackId: number;
  score: number;
  subScores?: Record<string, number>;
  surfaced: boolean;
};

export type RatingDecision = (typeof ratingDecisionEnum.enumValues)[number];
export type RecommendationKind = (typeof recommendationKindEnum.enumValues)[number];
export type RecommendationStatus = (typeof recommendationStatusEnum.enumValues)[number];

export type Track = typeof track.$inferSelect;
export type NewTrack = typeof track.$inferInsert;
export type Bucket = typeof bucket.$inferSelect;
export type NewBucket = typeof bucket.$inferInsert;
export type Rating = typeof rating.$inferSelect;
export type NewRating = typeof rating.$inferInsert;
export type SurfaceEvent = typeof surfaceEvent.$inferSelect;
export type NewSurfaceEvent = typeof surfaceEvent.$inferInsert;
export type ModelVersion = typeof modelVersion.$inferSelect;
export type NewModelVersion = typeof modelVersion.$inferInsert;
export type AppConfig = typeof appConfig.$inferSelect;
export type BucketRecommendation = typeof bucketRecommendation.$inferSelect;
export type NewBucketRecommendation = typeof bucketRecommendation.$inferInsert;
