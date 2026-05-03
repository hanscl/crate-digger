DROP INDEX "bucket_member_track_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "bucket_member_track_unique_idx" ON "bucket_member" USING btree ("track_id");