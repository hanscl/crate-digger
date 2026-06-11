ALTER TABLE "app_config" ADD COLUMN "similar_artist_cap" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "familiar_artist_keep_threshold" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "surface_artist_cap" integer DEFAULT 1 NOT NULL;