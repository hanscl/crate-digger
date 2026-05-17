ALTER TABLE "app_config" ALTER COLUMN "sources_enabled" SET DEFAULT '{"spotify":true,"lastfm":true,"viberate":false,"reccobeats":true}'::jsonb;
--> statement-breakpoint
-- Backfill the existing singleton row so the Sources screen shows the
-- ReccoBeats toggle immediately. The column default above only affects
-- newly-inserted rows.
UPDATE "app_config" SET "sources_enabled" = "sources_enabled" || '{"reccobeats":true}'::jsonb WHERE NOT ("sources_enabled" ? 'reccobeats');
