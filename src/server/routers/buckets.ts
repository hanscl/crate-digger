import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { bucket, bucketMember, bucketRecommendation, rating, track } from "@/db/schema";
import { addFeatureSample, emptyFeatureStats } from "@/lib/bucketing/centroid";
import {
  evaluateBucketRecommendations,
  listPendingRecommendations,
} from "@/lib/bucketing/recommendations";
import { renameEligibleBuckets } from "@/mastra/lib/pipeline-steps";
import { protectedProcedure, router } from "../trpc-base";

/**
 * Buckets router — backs the Buckets screen (#02). Read-mostly per
 * Constraint #7; the only writes are rename, recommendation accept/dismiss,
 * and an explicit recompute trigger. Merge/split is recommendation-driven.
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const bucketsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(bucket).orderBy(desc(bucket.memberCount), bucket.id);
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

  recommendations: protectedProcedure.query(async ({ ctx }) => {
    const rows = await listPendingRecommendations(ctx.db);
    return rows;
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
          const [keepId, mergeId] = [...rec.bucketIds].sort((a, b) => a - b);
          if (keepId === undefined || mergeId === undefined || keepId === mergeId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "merge recommendation must reference two distinct buckets",
            });
          }
          await tx
            .update(bucketMember)
            .set({ bucketId: keepId })
            .where(eq(bucketMember.bucketId, mergeId));
          await tx.delete(bucket).where(eq(bucket.id, mergeId));
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

type Tx = Parameters<Parameters<import("@/db/client").Database["transaction"]>[0]>[0];

async function recomputeBucketStats(tx: Tx, bucketId: number): Promise<void> {
  const members = await tx
    .select({
      embedding: track.embedding,
      audioFeatures: track.audioFeatures,
    })
    .from(bucketMember)
    .innerJoin(track, eq(track.id, bucketMember.trackId))
    .where(eq(bucketMember.bucketId, bucketId));

  if (members.length === 0) {
    await tx.delete(bucket).where(eq(bucket.id, bucketId));
    return;
  }

  // Derive the centroid dimension from the first member that actually has an
  // embedding — `members[0]` may have `embedding = null`, which would force
  // the fallback dim and silently truncate later real embeddings.
  const firstEmbedding = members.find((m) => m.embedding && m.embedding.length > 0)?.embedding;
  const dim = firstEmbedding?.length ?? 64;
  const centroid = Array.from({ length: dim }, () => 0);
  let n = 0;
  for (const m of members) {
    if (!m.embedding) continue;
    for (let i = 0; i < dim; i++) centroid[i]! += m.embedding[i] ?? 0;
    n += 1;
  }
  if (n > 0) {
    for (let i = 0; i < dim; i++) centroid[i] = centroid[i]! / n;
  }
  // We rebuild Welford from scratch since the merge changes the population.
  // Cheap at our scale (a bucket holds tens of members at most).
  let stats = emptyFeatureStats();
  for (const m of members) {
    if (!m.audioFeatures) continue;
    stats = addFeatureSample(stats, m.audioFeatures);
  }

  // dislike_count is the number of distinct tracks currently in this bucket
  // that have at least one dislike rating. Recompute it from the union of
  // members so the merged bucket's purity LED reflects inherited dislikes
  // instead of just the surviving bucket's pre-merge tally.
  const [dislikeRow] = await tx
    .select({ dislikes: sql<number>`count(distinct ${rating.trackId})::int` })
    .from(bucketMember)
    .innerJoin(rating, eq(rating.trackId, bucketMember.trackId))
    .where(and(eq(bucketMember.bucketId, bucketId), eq(rating.decision, "dislike")));
  const dislikeCount = Number(dislikeRow?.dislikes ?? 0);

  await tx
    .update(bucket)
    .set({
      centroid,
      featureStats: stats,
      memberCount: members.length,
      dislikeCount,
      updatedAt: sql`NOW()`,
    })
    .where(eq(bucket.id, bucketId));
}
