ALTER TABLE "track" ADD COLUMN "candidate_bucket_id" integer;--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "candidate_score" double precision;--> statement-breakpoint
ALTER TABLE "track" ADD CONSTRAINT "track_candidate_bucket_id_bucket_id_fk" FOREIGN KEY ("candidate_bucket_id") REFERENCES "public"."bucket"("id") ON DELETE set null ON UPDATE no action;