ALTER TABLE "bucket" ADD COLUMN "last_named_at_count" integer;--> statement-breakpoint
ALTER TABLE "bucket" ADD COLUMN "last_named_centroid" vector(64);