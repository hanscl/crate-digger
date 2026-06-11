import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { bucket, bucketMember, bucketRecommendation } from "@/db/schema";
import {
  bumpModelVersionCarryForwardInTx,
  mintRefillConfigUpgradeInTx,
} from "@/lib/ranking/version";
import { evaluateBucketRecommendations } from "./recommendations";
import { recomputeBucketStats } from "./recompute";

/**
 * LAB-61 — post-migration bucket reconcile sweep. The 0011 backfill deletes
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
 *       index keeps them from re-surfacing as pending). Additionally, iff
 *       MEMBERSHIP changed (step (a) repaired at least one bucket), the
 *       refill model_version is bumped EXACTLY once — the keep-anchor set
 *       changed, so subsequent ratings must not attribute to the pre-repair
 *       version (Constraint #3). A stale-recommendation-only repair touches
 *       no membership or geometry and mints nothing. The bump carries the
 *       active config forward (read under the app_config lock, so a
 *       concurrent config change is never reverted) and is skipped when no
 *       active refill version exists yet (nothing to chain from; the
 *       surfacing bootstrap mints the first version).
 *
 * Idempotent and drift-gated: a second run finds counts consistent and no
 * stale references, repairs nothing, and therefore bumps nothing and leaves
 * recommendations untouched.
 *
 * LAB-36/73 — a second idempotent step runs AFTER the membership repair: when
 * the ACTIVE refill version's config is missing any later config field
 * (audioWeight / genreGate from LAB-36, or the LAB-73 novelty-scaled
 * familiarityPenalty), mint ONE refill version carrying the present fields
 * forward and filling in the missing ones (slot-overlap gate + audio-weighted
 * cosine + familiarity penalty from `app_config.novelty`; see
 * `mintRefillConfigUpgradeInTx`). A post-LAB-36 install already carries
 * audioWeight+genreGate, so this is what lights up the LAB-73 penalty on it.
 * Composition with the membership-gated bump above: separate version rows,
 * separate notes — a drifted install minting both gets `repair → upgrade`
 * chained in that order. Both steps are no-ops on re-run, so `db:migrate`
 * stays exactly-once. Fresh installs never fire it (their bootstrap mints the
 * full config directly).
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
  /** True when the refill model_version was bumped (membership changed AND an active pointer was set). */
  refillVersionBumped: boolean;
  /** LAB-36/73 — true when the active refill config was upgraded with a missing field (audioWeight/genreGate/familiarityPenalty) this run. */
  refillConfigUpgraded: boolean;
  /** True when anything at all was repaired this run (config upgrade excluded — it is not a repair). */
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

      // Bump only when MEMBERSHIP changed: a stale-recommendation-only repair
      // touches no keep-anchor geometry, so minting a version there would put
      // a false "ranker changed" marker in the chain (Constraint #3). The
      // carry-forward variant reads the active config under the app_config
      // lock and returns null when no active refill version exists yet.
      if (driftedBucketIds.length > 0) {
        const bumped = await bumpModelVersionCarryForwardInTx(tx, "refill", {
          note:
            "bucket reconcile: membership repair changed the refill keep-anchor set " +
            `(buckets ${driftedBucketIds.join(", ")})`,
        });
        refillVersionBumped = bumped !== null;
      }
    }

    // LAB-36/73 — refill config upgrade for existing installs, AFTER the
    // membership step so a drifted upgrade chains repair → upgrade. Self-gating
    // and lock-serialized; null means "already upgraded or nothing to upgrade".
    const upgraded = await mintRefillConfigUpgradeInTx(tx, {
      note: "refill config upgrade: slot-overlap gate + audio-weighted cosine + familiarity penalty",
    });
    const refillConfigUpgraded = upgraded !== null;

    return {
      driftedBucketIds,
      prunedBucketIds,
      staleRecommendationCount,
      recommendationsRebuilt,
      refillVersionBumped,
      refillConfigUpgraded,
      repaired,
    };
  });
}
