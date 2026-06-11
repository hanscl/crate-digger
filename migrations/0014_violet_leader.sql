ALTER TYPE "public"."source_kind" ADD VALUE 'tiktok';--> statement-breakpoint
ALTER TABLE "app_config" ALTER COLUMN "sources_enabled" SET DEFAULT '{"spotify":true,"lastfm":true,"viberate":false,"reccobeats":true,"tiktok":false}'::jsonb;--> statement-breakpoint
-- Backfill the existing singleton row so the Sources screen shows the TikTok
-- toggle off-by-default (mirrors the 0003 ReccoBeats backfill). The column
-- default above only affects newly-inserted rows; `|| WHERE NOT (… ? 'tiktok')`
-- adds the key only where absent, preserving any user setting.
UPDATE "app_config" SET "sources_enabled" = "sources_enabled" || '{"tiktok":false}'::jsonb WHERE NOT ("sources_enabled" ? 'tiktok');