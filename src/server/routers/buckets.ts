import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bucket,
  bucketMember,
  type BucketMemberOrigin,
  bucketMemberOriginEnum,
  bucketRecommendation,
  rating,
  track,
} from "@/db/schema";
import { recomputeBucketStats } from "@/lib/bucketing/recompute";
import {
  evaluateBucketRecommendations,
  listPendingRecommendations,
} from "@/lib/bucketing/recommendations";
import { renameEligibleBuckets } from "@/mastra/lib/pipeline-steps";
import { protectedProcedure, router } from "../trpc-base";

/**
 * Buckets router — backs the Buckets screen (#02). Read-mostly per
 * Constraint #7; the only writes are rename, recommendation accept/dismiss,
 * an explicit recompute trigger, and single-member removal (LAB-62 manual
 * curation). Merge/split is recommendation-driven.
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const bucketsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(bucket).orderBy(desc(bucket.memberCount), bucket.id);
    // LAB-61 — provenance tallies for every bucket in one GROUP BY.
    const originRows = await ctx.db
      .select({ bucketId: bucketMember.bucketId, origin: bucketMember.origin, n: count() })
      .from(bucketMember)
      .groupBy(bucketMember.bucketId, bucketMember.origin);
    const originsByBucket = new Map<number, OriginCounts>();
    for (const r of originRows) {
      const entry = originsByBucket.get(r.bucketId) ?? emptyOriginCounts();
      entry[r.origin] = Number(r.n);
      originsByBucket.set(r.bucketId, entry);
    }
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      color: b.color,
      primaryGenre: b.primaryGenre,
      memberCount: b.memberCount,
      dislikeCount: b.dislikeCount,
      isColdStartSeed: b.isColdStartSeed,
      centroid: b.centroid,
      featureStats: b.featureStats,
      originCounts: originsByBucket.get(b.id) ?? emptyOriginCounts(),
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
  }),

  detail: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const [b] = await ctx.db.select().from(bucket).where(eq(bucket.id, input.id)).limit(1);
      if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "bucket not found" });
      const members = await ctx.db
        .select({
          trackId: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          primaryGenre: track.primaryGenre,
          audioFeatures: track.audioFeatures,
          similarityAtJoin: bucketMember.similarityAtJoin,
          origin: bucketMember.origin,
          addedAt: bucketMember.addedAt,
        })
        .from(bucketMember)
        .innerJoin(track, eq(track.id, bucketMember.trackId))
        .where(eq(bucketMember.bucketId, input.id))
        .orderBy(desc(bucketMember.addedAt));

      // Per-member latest decision so the UI can color "kept" vs "disliked"
      // members. Cheap join — we already paginated to the bucket's members.
      const latestRatings = await ctx.db
        .select({
          trackId: rating.trackId,
          decision: rating.decision,
          ratedAt: rating.ratedAt,
        })
        .from(rating)
        .innerJoin(bucketMember, eq(bucketMember.trackId, rating.trackId))
        .where(eq(bucketMember.bucketId, input.id))
        .orderBy(desc(rating.ratedAt), desc(rating.id));
      const decisionByTrack = new Map<number, "keep" | "dislike" | "defer" | "neutral">();
      for (const r of latestRatings) {
        if (decisionByTrack.has(r.trackId)) continue;
        decisionByTrack.set(r.trackId, r.decision);
      }
      // LAB-61 — provenance tallies; derived from the member rows we already
      // fetched rather than a second query.
      const originCounts = emptyOriginCounts();
      for (const m of members) originCounts[m.origin] += 1;
      return {
        bucket: {
          id: b.id,
          name: b.name,
          color: b.color,
          primaryGenre: b.primaryGenre,
          memberCount: b.memberCount,
          dislikeCount: b.dislikeCount,
          isColdStartSeed: b.isColdStartSeed,
          centroid: b.centroid,
          featureStats: b.featureStats,
          originCounts,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        },
        members: members.map((m) => ({
          ...m,
          latestDecision: decisionByTrack.get(m.trackId) ?? null,
        })),
      };
    }),

  rename: protectedProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(60),
        color: z.string().regex(HEX_COLOR, "color must be #rrggbb").nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // LAB-25: reset the drift-tracking anchor so the rename step's
      // doubling / drift conditions can't overwrite a manual rename on a
      // subsequent run. The `isRenameEligible` rule treats
      // `lastNamedAtCount = null` + non-placeholder name as "human-chosen,
      // do not touch."
      const [updated] = await ctx.db
        .update(bucket)
        .set({
          name: input.name,
          ...(input.color !== undefined ? { color: input.color } : {}),
          lastNamedAtCount: null,
          lastNamedCentroid: null,
          updatedAt: sql`NOW()`,
        })
        .where(eq(bucket.id, input.id))
        .returning({ id: bucket.id });
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "bucket not found" });
      return { ok: true };
    }),

  /**
   * LAB-62 — manual curation: drop a single membership and recompute the
   * bucket's derived geometry from the remaining members. The track row and
   * any rating rows are untouched (membership and rating are independent
   * dimensions — same rule as the LAB-61 cleanup). Removing the last member
   * prunes the bucket (recomputeBucketStats handles that).
   */
  removeMember: protectedProcedure
    .input(
      z.object({
        bucketId: z.number().int().positive(),
        trackId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const deleted = await tx
          .delete(bucketMember)
          .where(
            and(eq(bucketMember.bucketId, input.bucketId), eq(bucketMember.trackId, input.trackId)),
          )
          .returning({ id: bucketMember.id });
        if (deleted.length === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
        }
        // Pending recommendations were computed against the old membership —
        // prune any referencing this bucket (mirrors merge-accept's
        // dangling-ref cleanup; the next evaluation rebuilds from current
        // geometry).
        await tx.delete(bucketRecommendation).where(
          sql`${bucketRecommendation.status} = 'pending'
            AND ${input.bucketId} = ANY(${bucketRecommendation.bucketIds})`,
        );
        await recomputeBucketStats(tx, input.bucketId);
        const [still] = await tx
          .select({ id: bucket.id })
          .from(bucket)
          .where(eq(bucket.id, input.bucketId))
          .limit(1);
        return { ok: true, bucketPruned: !still };
      });
    }),

  recommendations: protectedProcedure.query(async ({ ctx }) => {
    const rows = await listPendingRecommendations(ctx.db);
    // LAB-76 — join bucket NAMES into the payload so the client renders names
    // (clickable to select) instead of raw ids. A recommendation references
    // 1 (split) or 2 (merge) bucket ids via the plain `bucket_ids` int[]; a
    // referenced bucket can be missing (a concurrent merge/removeMember prunes
    // it before the next recompute), so the name is nullable per id.
    const referencedIds = [...new Set(rows.flatMap((r) => r.bucketIds))];
    const nameRows = referencedIds.length
      ? await ctx.db
          .select({ id: bucket.id, name: bucket.name, color: bucket.color })
          .from(bucket)
          .where(inArray(bucket.id, referencedIds))
      : [];
    const nameById = new Map(nameRows.map((b) => [b.id, { name: b.name, color: b.color }]));
    return rows.map((r) => ({
      ...r,
      buckets: r.bucketIds.map((id) => ({
        id,
        name: nameById.get(id)?.name ?? null,
        color: nameById.get(id)?.color ?? null,
      })),
    }));
  }),

  /** Manual trigger for the Phase 5 recommendations heuristic. */
  recompute: protectedProcedure.mutation(async ({ ctx }) => {
    const result = await evaluateBucketRecommendations(ctx.db);
    return {
      newMergeCount: result.merges.length,
      newSplitCount: result.splits.length,
      totalPending: result.totalPending,
    };
  }),

  /**
   * LAB-25 backfill: name all `(auto)` placeholder buckets that have reached
   * the lazy-naming threshold, plus re-name buckets whose centroid drifted
   * significantly since their last agent naming. Idempotent — eligibility
   * filter rejects already-named buckets without drift.
   *
   * Same code path as the daily-pipeline rename step; this just lets the
   * user trigger it on demand from the Buckets screen.
   */
  renamePlaceholders: protectedProcedure.mutation(async ({ ctx }) => {
    const result = await renameEligibleBuckets(ctx.db, ctx.appEnv);
    return {
      eligibleCount: result.eligibleCount,
      renamedCount: result.renamedCount,
      errorCount: result.errorCount,
    };
  }),

  /**
   * Accept a merge recommendation: fold member B into bucket A, delete B.
   * Centroid + Welford stats are recomputed from the union of members so the
   * merged bucket's geometry stays correct. Constraint #7: writes are limited
   * to user-confirmed merge/split application.
   */
  accept: protectedProcedure
    .input(z.object({ recommendationId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        // SELECT FOR UPDATE locks the recommendation row so two concurrent
        // accepts on the same id serialize — without this, READ COMMITTED
        // lets both pass the pending check before either commits.
        const [rec] = await tx
          .select()
          .from(bucketRecommendation)
          .where(
            and(
              eq(bucketRecommendation.id, input.recommendationId),
              eq(bucketRecommendation.status, "pending"),
            ),
          )
          .for("update")
          .limit(1);
        if (!rec) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "recommendation not pending or not found",
          });
        }

        // Splits are not auto-applied — they require interactive partitioning.
        // Reject the accept so the audit trail doesn't show a no-op as
        // "accepted"; operators should `dismiss` to ignore.
        if (rec.kind === "split") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "split recommendations are not auto-applied; dismiss instead",
          });
        }

        if (rec.kind === "merge") {
          const ids = [...rec.bucketIds];
          if (
            ids.length !== 2 ||
            ids[0] === undefined ||
            ids[1] === undefined ||
            ids[0] === ids[1]
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "merge recommendation must reference two distinct buckets",
            });
          }
          // LAB-81 — keep the LARGER-member bucket (fold smaller into larger),
          // tie-break on lower id. A singleton folding into its populated
          // neighbor must absorb INTO the established shelf so the survivor
          // keeps that shelf's name/identity; keeping min(id) could instead
          // fold a populated lane into a one-track "(auto)" seed bucket.
          // FOR UPDATE locks both bucket rows for the txn so a concurrent
          // member recompute (removeMember / reconcile) can't commit between
          // here and the fold below and flip which bucket is the larger one —
          // the rec-row lock above only serializes concurrent accepts, not
          // writers on these two buckets.
          const sizes = await tx
            .select({ id: bucket.id, memberCount: bucket.memberCount })
            .from(bucket)
            .where(inArray(bucket.id, ids))
            .for("update");
          if (sizes.length !== 2) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "merge recommendation references a bucket that no longer exists",
            });
          }
          sizes.sort((x, y) => y.memberCount - x.memberCount || x.id - y.id);
          const keepId = sizes[0]!.id;
          const mergeId = sizes[1]!.id;
          await tx
            .update(bucketMember)
            .set({ bucketId: keepId })
            .where(eq(bucketMember.bucketId, mergeId));
          await tx.delete(bucket).where(eq(bucket.id, mergeId));
          // `bucket_recommendation.bucket_ids` is a plain int[] with no FK —
          // other pending recommendations referencing the merged-away bucket
          // would dangle forever, so prune them here. The row being accepted
          // is resolved below and keeps its audit trail.
          await tx.delete(bucketRecommendation).where(
            sql`${bucketRecommendation.status} = 'pending'
              AND ${bucketRecommendation.id} <> ${rec.id}
              AND ${mergeId} = ANY(${bucketRecommendation.bucketIds})`,
          );
          // Recompute the merged bucket's centroid + counts from current members.
          await recomputeBucketStats(tx, keepId);
        }

        await tx
          .update(bucketRecommendation)
          .set({ status: "accepted", resolvedAt: sql`NOW()` })
          .where(eq(bucketRecommendation.id, rec.id));
        return { ok: true, kind: rec.kind };
      });
    }),

  dismiss: protectedProcedure
    .input(z.object({ recommendationId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // Pending-only guard mirrors `accept`: prevents an operator from
      // overwriting an already-applied recommendation's audit trail.
      const [rec] = await ctx.db
        .update(bucketRecommendation)
        .set({ status: "dismissed", resolvedAt: sql`NOW()` })
        .where(
          and(
            eq(bucketRecommendation.id, input.recommendationId),
            eq(bucketRecommendation.status, "pending"),
          ),
        )
        .returning({ id: bucketRecommendation.id });
      if (!rec) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "recommendation not pending or not found",
        });
      }
      return { ok: true };
    }),
});

/** LAB-61 — per-bucket membership provenance tallies, keyed by origin value. */
type OriginCounts = Record<BucketMemberOrigin, number>;

function emptyOriginCounts(): OriginCounts {
  return Object.fromEntries(bucketMemberOriginEnum.enumValues.map((o) => [o, 0])) as OriginCounts;
}
