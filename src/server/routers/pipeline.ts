import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { retrainBroad } from "@/lib/feedback/retrain";
import { runDailyPipeline } from "../pipeline-run";
import { protectedProcedure, router } from "../trpc-base";

/**
 * Pipeline router — Console "Run now" + "Retrain now" buttons.
 *
 * The Mastra workflow orchestrates ingest → enrich → bucket → retrain →
 * recommend → surface. Cron auto-fires daily; the Console can fire it on
 * demand to demo the loop or recover from a missed run. Both paths share
 * `runDailyPipeline`, which serializes runs so a manual trigger can't
 * interleave with the scheduled one.
 */
export const pipelineRouter = router({
  runNow: protectedProcedure.mutation(async ({ ctx }) => {
    const result = await runDailyPipeline({ db: ctx.db, env: ctx.appEnv });
    if (result.status !== "success" || !result.output) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `daily-pipeline ended with status "${result.status}"`,
      });
    }
    return {
      ok: true,
      status: result.status,
      surfacedCount: result.output.surfacedCount,
      excludedDecidedCount: result.output.excludedDecidedCount,
      excludedPendingCount: result.output.excludedPendingCount,
      // LAB-73 — artist-diversity counters for the Console run summary.
      similarArtistCappedCount: result.output.similarArtistCappedCount,
      similarFamiliarSkippedCount: result.output.similarFamiliarSkippedCount,
      artistQuotaDeferredCount: result.output.artistQuotaDeferredCount,
    };
  }),

  retrainNow: protectedProcedure
    .input(
      z
        .object({
          windowStart: z.date().optional(),
          windowEnd: z.date().optional(),
          note: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await retrainBroad(ctx.db, {
        windowStart: input?.windowStart,
        windowEnd: input?.windowEnd,
        note: input?.note,
      });
      return {
        skipped: result.skipped,
        skipReason: result.skipReason,
        sampleCount: result.sampleCount,
        modelVersionId: result.modelVersion?.id ?? null,
        finalLoss: result.training.finalLoss,
      };
    }),
});
