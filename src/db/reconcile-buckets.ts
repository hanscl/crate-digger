import { reconcileBuckets } from "@/lib/bucketing/reconcile";
import { closeDb, getDb } from "./client";

/**
 * CLI entry for the LAB-61 bucket reconcile sweep — chained into
 * `pnpm db:migrate` (and therefore the Fly release_command) right after
 * `drizzle-kit migrate`, so derived bucket state is repaired on the same
 * deploy that runs a membership-mutating migration. Exit code 0 = clean
 * no-op or successful repair; non-zero only on error (deploys abort on it).
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const db = getDb(url);

try {
  const result = await reconcileBuckets(db);
  if (result.repaired) {
    console.log(
      `bucket reconcile: repaired — drifted=[${result.driftedBucketIds.join(", ")}] ` +
        `pruned=[${result.prunedBucketIds.join(", ")}] ` +
        `staleRecommendations=${result.staleRecommendationCount} ` +
        `recommendationsRebuilt=${result.recommendationsRebuilt} ` +
        `refillVersionBumped=${result.refillVersionBumped}`,
    );
  } else {
    console.log("bucket reconcile: clean — nothing to repair");
  }
  if (result.refillConfigUpgraded) {
    console.log(
      "bucket reconcile: LAB-36 refill config upgraded (slot-overlap gate + audio-weighted cosine)",
    );
  }
} catch (err) {
  console.error("bucket reconcile failed:", err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
