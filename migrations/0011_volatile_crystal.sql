CREATE TYPE "public"."bucket_member_origin" AS ENUM('seed_playlist', 'seed_track', 'seed_manual', 'discovery_keep');--> statement-breakpoint
-- LAB-61 — add the column nullable first; the backfill below decides each
-- existing row's origin before the NOT NULL constraint lands.
ALTER TABLE "bucket_member" ADD COLUMN "origin" "bucket_member_origin";--> statement-breakpoint
-- LAB-61 cleanup of pre-LAB-52 eager-joins: a member whose track was rated
-- but never kept (dislike-only, defer-only, neutral-only) is treated as
-- eager-join cruft — it was never approved into the bucket and self-anchors
-- refill at keepSim=1.000. Membership rows go; rating rows are untouched
-- (the eval substrate keeps every decision — Constraints #2/#3).
-- Known residual: pre-LAB-61 rows carry no provenance, so a membership the
-- user deliberately created through Setup seeding AFTER rating the track
-- elsewhere (e.g. defer-then-seed) is indistinguishable from cruft and is
-- also deleted. Recoverable by re-seeding the track.
DELETE FROM "bucket_member" bm
WHERE EXISTS (SELECT 1 FROM "rating" r WHERE r."track_id" = bm."track_id")
  AND NOT EXISTS (
    SELECT 1 FROM "rating" r
    WHERE r."track_id" = bm."track_id" AND r."decision" = 'keep'
  );--> statement-breakpoint
-- Backfill: a kept member joined (or was retroactively approved) through the
-- discovery flow.
UPDATE "bucket_member" bm SET "origin" = 'discovery_keep'
WHERE EXISTS (
  SELECT 1 FROM "rating" r
  WHERE r."track_id" = bm."track_id" AND r."decision" = 'keep'
);--> statement-breakpoint
-- Remaining members (no rating at all) are cold-start seeds. The schema
-- carries no record of WHICH seeding flow added them, so they all get the
-- generic 'seed_track' label — cosmetic only; every seed origin anchors
-- refill identically.
UPDATE "bucket_member" SET "origin" = 'seed_track' WHERE "origin" IS NULL;--> statement-breakpoint
ALTER TABLE "bucket_member" ALTER COLUMN "origin" SET NOT NULL;
