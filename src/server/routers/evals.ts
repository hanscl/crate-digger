import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { modelVersion, rating, surfaceEvent, track } from "@/db/schema";
import { counterfactualReplay } from "@/lib/evals/counterfactual";
import { loadKpis } from "@/lib/evals/metrics";
import { listModelVersions } from "@/lib/ranking/version";
import { protectedProcedure, router } from "../trpc";

/**
 * Evals router — backs the Analyzer screen (#03). All read-only — the
 * Analyzer is a viewing surface; the only "writes" come from the Console
 * (Phase 4 retrain trigger, params router) and Buckets (recommendations).
 */

const RANKER_KIND = z.enum(["refill", "broad"]);

export const evalsRouter = router({
  kpis: protectedProcedure
    .input(
      z
        .object({
          start: z.date().nullable().optional(),
          end: z.date().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return loadKpis(ctx.db, {
        start: input?.start ?? null,
        end: input?.end,
      });
    }),

  /** All versions of a kind, newest-first. Drives Analyzer's version dropdown. */
  versions: protectedProcedure
    .input(z.object({ kind: RANKER_KIND, limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const rows = await listModelVersions(ctx.db, input.kind, { limit: input.limit });
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        trainedAt: row.trainedAt,
        parentId: row.parentId,
        note: row.note,
        trainingWindowStart: row.trainingWindowStart,
        trainingWindowEnd: row.trainingWindowEnd,
      }));
    }),

  /**
   * Counterfactual replay: re-rank historical surface_event pools under a
   * target model_version. The Analyzer table walks `perEvent` to show
   * agreement/disagreement and keep-vs-dislike under the would-have ranker.
   */
  counterfactual: protectedProcedure
    .input(
      z.object({
        targetVersionId: z.number().int().positive(),
        limit: z.number().int().min(1).max(500).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [v] = await ctx.db
        .select({ id: modelVersion.id })
        .from(modelVersion)
        .where(eq(modelVersion.id, input.targetVersionId))
        .limit(1);
      if (!v) {
        throw new TRPCError({ code: "NOT_FOUND", message: "model version not found" });
      }
      return counterfactualReplay(ctx.db, input.targetVersionId, { limit: input.limit });
    }),

  /**
   * Recent surface events with their decisions — feeds the Analyzer's
   * "recent decisions" timeline. Lightweight — no full pool returned.
   */
  recentSurface: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const rows = await ctx.db
        .select({
          eventId: surfaceEvent.id,
          surfacedAt: surfaceEvent.surfacedAt,
          rankerKind: surfaceEvent.rankerKind,
          winnerScore: surfaceEvent.winnerScore,
          modelVersionId: surfaceEvent.modelVersionId,
          trackId: track.id,
          title: track.title,
          artist: track.artist,
          decision: rating.decision,
        })
        .from(surfaceEvent)
        .innerJoin(track, eq(track.id, surfaceEvent.trackId))
        .leftJoin(rating, eq(rating.surfaceEventId, surfaceEvent.id))
        .orderBy(desc(surfaceEvent.surfacedAt), desc(surfaceEvent.id))
        .limit(limit);
      return rows;
    }),
});
