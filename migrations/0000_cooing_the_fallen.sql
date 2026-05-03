CREATE TYPE "public"."model_version_kind" AS ENUM('refill', 'broad');--> statement-breakpoint
CREATE TYPE "public"."ranker_kind" AS ENUM('refill', 'broad');--> statement-breakpoint
CREATE TYPE "public"."rating_decision" AS ENUM('keep', 'dislike', 'defer', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."bucket_recommendation_kind" AS ENUM('merge', 'split');--> statement-breakpoint
CREATE TYPE "public"."bucket_recommendation_status" AS ENUM('pending', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('spotify', 'lastfm', 'viberate');--> statement-breakpoint
CREATE TABLE "app_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"novelty" double precision DEFAULT 0.5 NOT NULL,
	"source_mix" double precision DEFAULT 0.5 NOT NULL,
	"daily_surface_cap" integer DEFAULT 15 NOT NULL,
	"queue_ceiling" integer DEFAULT 50 NOT NULL,
	"retrain_cadence" text DEFAULT 'daily' NOT NULL,
	"spawn_threshold" double precision DEFAULT 0.7 NOT NULL,
	"refill_lambda" double precision DEFAULT 0.3 NOT NULL,
	"merge_threshold" double precision DEFAULT 0.92 NOT NULL,
	"split_dislike_rate" double precision DEFAULT 0.5 NOT NULL,
	"sources_enabled" jsonb DEFAULT '{"spotify":true,"lastfm":true,"viberate":false}'::jsonb NOT NULL,
	"active_refill_version_id" integer,
	"active_broad_version_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_config_singleton_chk" CHECK ("app_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "bucket" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"centroid" vector(64) NOT NULL,
	"feature_stats" jsonb NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"dislike_count" integer DEFAULT 0 NOT NULL,
	"is_cold_start_seed" boolean DEFAULT false NOT NULL,
	"primary_genre" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bucket_member" (
	"id" serial PRIMARY KEY NOT NULL,
	"bucket_id" integer NOT NULL,
	"track_id" integer NOT NULL,
	"similarity_at_join" double precision,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bucket_recommendation" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "bucket_recommendation_kind" NOT NULL,
	"bucket_ids" integer[] NOT NULL,
	"reason" jsonb NOT NULL,
	"status" "bucket_recommendation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "model_version_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"training_window_start" timestamp with time zone,
	"training_window_end" timestamp with time zone,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" integer,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "rating" (
	"id" serial PRIMARY KEY NOT NULL,
	"track_id" integer NOT NULL,
	"decision" "rating_decision" NOT NULL,
	"model_version_id" integer NOT NULL,
	"surface_event_id" integer,
	"rated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" "source_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"count_pulled" integer DEFAULT 0 NOT NULL,
	"count_surfaced" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "surface_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"track_id" integer NOT NULL,
	"ranker_kind" "ranker_kind" NOT NULL,
	"bucket_id" integer,
	"model_version_id" integer NOT NULL,
	"features_at_decision" jsonb NOT NULL,
	"winner_score" double precision NOT NULL,
	"candidate_pool" jsonb NOT NULL,
	"surfaced_reason" text,
	"surfaced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track" (
	"id" serial PRIMARY KEY NOT NULL,
	"isrc" text,
	"spotify_id" text,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"album" text,
	"release_year" integer,
	"duration_ms" integer,
	"audio_features" jsonb,
	"genres" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"primary_genre" text,
	"embedding" vector(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_source" (
	"id" serial PRIMARY KEY NOT NULL,
	"track_id" integer NOT NULL,
	"source" "source_kind" NOT NULL,
	"source_track_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "app_config" ADD CONSTRAINT "app_config_active_refill_version_id_model_version_id_fk" FOREIGN KEY ("active_refill_version_id") REFERENCES "public"."model_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_config" ADD CONSTRAINT "app_config_active_broad_version_id_model_version_id_fk" FOREIGN KEY ("active_broad_version_id") REFERENCES "public"."model_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket_member" ADD CONSTRAINT "bucket_member_bucket_id_bucket_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."bucket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket_member" ADD CONSTRAINT "bucket_member_track_id_track_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."track"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_version" ADD CONSTRAINT "model_version_parent_id_model_version_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."model_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating" ADD CONSTRAINT "rating_track_id_track_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."track"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating" ADD CONSTRAINT "rating_model_version_id_model_version_id_fk" FOREIGN KEY ("model_version_id") REFERENCES "public"."model_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating" ADD CONSTRAINT "rating_surface_event_id_surface_event_id_fk" FOREIGN KEY ("surface_event_id") REFERENCES "public"."surface_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_event" ADD CONSTRAINT "surface_event_track_id_track_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."track"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_event" ADD CONSTRAINT "surface_event_bucket_id_bucket_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."bucket"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_event" ADD CONSTRAINT "surface_event_model_version_id_model_version_id_fk" FOREIGN KEY ("model_version_id") REFERENCES "public"."model_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_source" ADD CONSTRAINT "track_source_track_id_track_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."track"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bucket_centroid_hnsw_idx" ON "bucket" USING hnsw ("centroid" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "bucket_primary_genre_idx" ON "bucket" USING btree ("primary_genre");--> statement-breakpoint
CREATE UNIQUE INDEX "bucket_member_unique_idx" ON "bucket_member" USING btree ("bucket_id","track_id");--> statement-breakpoint
CREATE INDEX "bucket_member_track_idx" ON "bucket_member" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "bucket_recommendation_status_idx" ON "bucket_recommendation" USING btree ("status");--> statement-breakpoint
CREATE INDEX "model_version_kind_trained_idx" ON "model_version" USING btree ("kind","trained_at");--> statement-breakpoint
CREATE INDEX "rating_track_idx" ON "rating" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "rating_rated_at_idx" ON "rating" USING btree ("rated_at");--> statement-breakpoint
CREATE INDEX "rating_model_version_idx" ON "rating" USING btree ("model_version_id");--> statement-breakpoint
CREATE INDEX "search_run_started_at_idx" ON "search_run" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "surface_event_track_idx" ON "surface_event" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "surface_event_surfaced_at_idx" ON "surface_event" USING btree ("surfaced_at");--> statement-breakpoint
CREATE INDEX "surface_event_model_version_idx" ON "surface_event" USING btree ("model_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "track_isrc_idx" ON "track" USING btree ("isrc");--> statement-breakpoint
CREATE UNIQUE INDEX "track_spotify_id_idx" ON "track" USING btree ("spotify_id");--> statement-breakpoint
CREATE INDEX "track_artist_title_idx" ON "track" USING btree ("artist","title");--> statement-breakpoint
CREATE INDEX "track_embedding_hnsw_idx" ON "track" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE UNIQUE INDEX "track_source_unique_idx" ON "track_source" USING btree ("source","source_track_id");--> statement-breakpoint
CREATE INDEX "track_source_track_id_idx" ON "track_source" USING btree ("track_id");