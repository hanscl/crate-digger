ALTER TABLE "app_config" ADD COLUMN "explore_limit_per_source" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "explore_cursor" integer DEFAULT 0 NOT NULL;