ALTER TYPE "public"."source_kind" ADD VALUE 'tiktok-playlist-seed';--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "inverse_popularity_weight" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "sources" jsonb DEFAULT '{"tiktokPlaylistSeed":{"playlistIds":["1RWfTxd358hSdujomctsGu","57EG9lWmdn7HHofXuQVsow"]}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "spotify_popularity" integer;