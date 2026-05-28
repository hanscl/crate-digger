ALTER TABLE "track" ADD COLUMN "mbid" text;--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "genre_sources_processed" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "track_mbid_idx" ON "track" USING btree ("mbid") WHERE "track"."mbid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "track_genre_sources_processed_idx" ON "track" USING gin ("genre_sources_processed");--> statement-breakpoint
-- Backfill: rows enriched under LAB-22 picked up their genres from Last.fm.
-- Mark them so the new per-source idempotency guards don't re-fetch.
UPDATE "track" SET "genre_sources_processed" = ARRAY['lastfm']::text[] WHERE cardinality("genres") > 0;