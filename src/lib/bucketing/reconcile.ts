import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { appConfig, bucket, bucketMember, bucketRecommendation, modelVersion } from "@/db/schema";
import { bumpModelVersionInTx, configFromVersion } from "@/lib/ranking/version";
import { evaluateBucketRecommendations } from "./recommendations";
import { recomputeBucketStats } from "./recompute";

/**
 * LAB-61 — post-migration bucket reconcile sweep. The 0010 backfill deletes
 * eager-join cruft from `bucket_member` in raw SQL, which leaves derived
 * state behind: `bucket.member_count`/centroid/feature_stats/dislike_count
 * drift from the surviving rows, emptied buckets linger, and pending
 * `bucket_recommendation` rows can reference buckets that no longer exist
 * (`bucket_ids` is a plain int[] — no FK to null them out). This sweep runs
 * as part of `db:migrate` (after `drizzle-kit migrate`) and repairs all of
 * it in ONE transaction:
 *
 *   (a) every bucket whose `member_count` disagrees with the actual
 *       `bucket_member` count is rebuilt via `recomputeBucketStats`
 *       (0-member buckets are deleted);
 *   (b) pending recommendations referencing a nonexistent bucket are deleted;
 *   (c) iff anything was repaired: the remaining pending recommendations are
 *       dropped and re-derived from the repaired bucket geometry (decided —
 *       accepted/dismissed — rows survive, and the (kind, bucket_ids) unique
 *       index keeps them from re-surfacing as pending), and the refill
 *       model_version is bumped EXACTLY once — the keep-anchor set changed,
 *       so subsequent ratings must not attribute to the pre-cleanup version
 *       (Constraint #3). The bump carries the current lambda forward and is
 *       skipped when no active refill version exists yet (nothing to chain
 *       from; the surfacing bootstrap mints the first version).
 *
 * Idempotent and drift-gated: a second run finds counts consistent and no
 * stale references, repairs nothing, and therefore bumps nothing and leaves
 * recommendations untouched.
 */
export type ReconcileBucketsResult = {
  /** Buckets whose member_count disagreed with the actual row count. */
  driftedBucketIds: number[];
  /** Subset of drifted buckets deleted because no members survived. */
  prunedBucketIds: number[];
  /** Pending recommendations deleted for referencing a nonexistent bucket. */
  staleRecommendationCount: number;
  /** True when step (c) ran (pending recs re-derived). */
  recommendationsRebuilt: boolean;
  /** True when the refill model_version was bumped (active pointer was set). */
  refillVersionBumped: boolean;
  /** True when anything at all was repaired this run. */
  repaired: boolean;
};

export async function reconcileBuckets(db: Database): Promise<ReconcileBucketsResult> {
  return db.transaction(async (tx) => {
    // (a) member_count drift — the only invariant raw-SQL membership deletes
    // can break that recompute can't be told about row by row.
    const drifted = await tx
      .select({ id: bucket.id })
      .from(bucket)
      .leftJoin(bucketMember, eq(bucketMember.bucketId, bucket.id))
      .groupBy(bucket.id)
      .having(sql`${bucket.memberCount} <> count(${bucketMember.id})`)
      .orderBy(bucket.id);
    const driftedBucketIds = drifted.map((r) => r.id);
    for (const id of driftedBucketIds) {
      await recomputeBucketStats(tx, id);
    }
    const surviving =
      driftedBucketIds.length === 0
        ? []
        : await tx
            .select({ id: bucket.id })
            .from(bucket)
            .where(inArray(bucket.id, driftedBucketIds));
    const survivingIds = new Set(surviving.map((r) => r.id));
    const prunedBucketIds = driftedBucketIds.filter((id) => !survivingIds.has(id));

    // (b) pending recommendations whose bucket_ids point at a deleted bucket.
    // Only pending rows: resolved ones are an audit trail and keep their ids.
    const staleRecs = await tx
      .delete(bucketRecommendation)
      .where(
        sql`${bucketRecommendation.status} = 'pending' AND EXISTS (
          SELECT 1 FROM unnest(${bucketRecommendation.bucketIds}) AS ref(bucket_id)
          WHERE NOT EXISTS (SELECT 1 FROM ${bucket} b WHERE b.id = ref.bucket_id)
        )`,
      )
      .returning({ id: bucketRecommendation.id });
    const staleRecommendationCount = staleRecs.length;

    const repaired = driftedBucketIds.length > 0 || staleRecommendationCount > 0;
    let recommendationsRebuilt = false;
    let refillVersionBumped = false;
    if (repaired) {
      // (c) the surviving pending recommendations were derived from pre-repair
      // geometry — drop and re-derive them all. Decided rows are untouched and
      // the unique (kind, bucket_ids) index blocks re-suggesting them.
      await tx.delete(bucketRecommendation).where(eq(bucketRecommendation.status, "pending"));
      await evaluateBucketRecommendations(tx);
      recommendationsRebuilt = true;

      const [cfg] = await tx
        .select({ activeRefill: appConfig.activeRefillVersionId })
        .from(appConfig)
        .limit(1);
      if (cfg?.activeRefill) {
        const [active] = await tx
          .select()
          .from(modelVersion)
          .where(eq(modelVersion.id, cfg.activeRefill))
          .limit(1);
        if (active) {
          const { lambda } = configFromVersion(active, "refill");
          await bumpModelVersionInTx(
            tx,
            "refill",
            { lambda },
            {
              note: "LAB-61: keep-anchor narrowed to seed/keep members; legacy eager-join cleanup",
            },
          );
          refillVersionBumped = true;
        }
      }
    }

    return {
      driftedBucketIds,
      prunedBucketIds,
      staleRecommendationCount,
      recommendationsRebuilt,
      refillVersionBumped,
      repaired,
    };
  });
}
