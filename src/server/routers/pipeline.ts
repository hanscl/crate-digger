import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { retrainBroad } from "@/lib/feedback/retrain";
import { mastra } from "@/mastra";
import { buildRequestContext } from "@/mastra/runtime";
import { protectedProcedure, router } from "../trpc-base";

/**
 * Pipeline router — Console "Run now" + "Retrain now" buttons.
 *
 * The Mastra workflow orchestrates ingest → enrich → bucket → retrain →
 * recommend → surface. Cron auto-fires daily; the Console can fire it on
 * demand to demo the loop or recover from a missed run.
 */
export const pipelineRouter = router({
  runNow: protectedProcedure.mutation(async ({ ctx }) => {
    const requestContext = buildRequestContext({ db: ctx.db, env: ctx.env });
    const workflow = mastra.getWorkflow("dailyPipeline");
    const run = await workflow.createRun();
    const result = await run.start({
      inputData: {},
      requestContext: requestContext as unknown as Parameters<
        typeof run.start
      >[0]["requestContext"],
    });
    if (result.status !== "success") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `daily-pipeline ended with status "${result.status}"`,
      });
    }
    return { ok: true, status: result.status };
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
