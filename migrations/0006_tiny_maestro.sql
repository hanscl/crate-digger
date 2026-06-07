ALTER TABLE "app_config" ADD COLUMN "trending_limit_per_source" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "similar_limit_per_source" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "similar_seed_buckets" integer DEFAULT 5 NOT NULL;