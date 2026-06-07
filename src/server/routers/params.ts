import { sql } from "drizzle-orm";
import { z } from "zod";
import { appConfig } from "@/db/schema";
import { bumpModelVersion, getActiveConfig } from "@/lib/ranking/version";
import { protectedProcedure, router } from "../trpc-base";

/**
 * Params router — backs the Console screen (#04). The Console is the only
 * surface that mutates `app_config`; the deterministic core elsewhere reads
 * it. Any change to `refillLambda` bumps the refill model_version (Constraint
 * #3) so subsequent ratings tag the new chain — that's how the Analyzer can
 * later compare "before tightening lambda" vs "after."
 */

const PARAMS_INPUT = z.object({
  novelty: z.number().min(0).max(1).optional(),
  sourceMix: z.number().min(0).max(1).optional(),
  queueCeiling: z.number().int().min(0).max(1000).optional(),
  // LAB-53 — per-ranker quality bars (live config; no model_version bump).
  refillQualityBar: z.number().min(0).max(1).optional(),
  broadQualityBar: z.number().min(0).max(1).optional(),
  spawnThreshold: z.number().min(0).max(1).optional(),
  refillLambda: z.number().min(0).max(5).optional(),
  mergeThreshold: z.number().min(0).max(1).optional(),
  splitDislikeRate: z.number().min(0).max(1).optional(),
  // LAB-51 — per-run pull throttle. min(0) allows disabling a pull mode
  // (0 trending = similar-only; 0 seed buckets = trending-only).
  trendingLimitPerSource: z.number().int().min(0).max(25).optional(),
  similarLimitPerSource: z.number().int().min(0).max(25).optional(),
  similarSeedBuckets: z.number().int().min(0).max(15).optional(),
});

export const paramsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db.select().from(appConfig).limit(1);
    if (!row) {
      // Cold install: insert defaults so the UI has something to render.
      await ctx.db.insert(appConfig).values({ id: 1 }).onConflictDoNothing();
      const [seeded] = await ctx.db.select().from(appConfig).limit(1);
      return seeded;
    }
    return row;
  }),

  update: protectedProcedure.input(PARAMS_INPUT).mutation(async ({ ctx, input }) => {
    const update: Record<string, unknown> = {};
    if (input.novelty !== undefined) update.novelty = input.novelty;
    if (input.sourceMix !== undefined) update.sourceMix = input.sourceMix;
    if (input.queueCeiling !== undefined) update.queueCeiling = input.queueCeiling;
    if (input.refillQualityBar !== undefined) update.refillQualityBar = input.refillQualityBar;
    if (input.broadQualityBar !== undefined) update.broadQualityBar = input.broadQualityBar;
    if (input.spawnThreshold !== undefined) update.spawnThreshold = input.spawnThreshold;
    if (input.refillLambda !== undefined) update.refillLambda = input.refillLambda;
    if (input.mergeThreshold !== undefined) update.mergeThreshold = input.mergeThreshold;
    if (input.splitDislikeRate !== undefined) update.splitDislikeRate = input.splitDislikeRate;
    if (input.trendingLimitPerSource !== undefined)
      update.trendingLimitPerSource = input.trendingLimitPerSource;
    if (input.similarLimitPerSource !== undefined)
      update.similarLimitPerSource = input.similarLimitPerSource;
    if (input.similarSeedBuckets !== undefined)
      update.similarSeedBuckets = input.similarSeedBuckets;
    if (Object.keys(update).length === 0) {
      return { ok: true, bumped: false, refillVersionId: null };
    }

    update.updatedAt = sql`NOW()`;

    // Read prior lambda, upsert, and conditionally bump the refill version in
    // a single transaction so concurrent submissions can't race past the
    // `!== priorLambda` guard and produce a duplicate or missing bump.
    return ctx.db.transaction(async (tx) => {
      // FOR UPDATE serializes concurrent submissions on the singleton row so
      // priorLambda reflects the latest committed state, not a stale snapshot.
      const [prior] = await tx.select().from(appConfig).for("update").limit(1);
      const priorLambda = prior?.refillLambda;

      await tx
        .insert(appConfig)
        .values({ id: 1, ...update })
        .onConflictDoUpdate({ target: appConfig.id, set: update });

      let bumpedVersionId: number | null = null;
      if (
        input.refillLambda !== undefined &&
        priorLambda !== undefined &&
        input.refillLambda !== priorLambda
      ) {
        const config = await getActiveConfig(tx, "refill");
        const newVersion = await bumpModelVersion(
          tx,
          "refill",
          { ...config, lambda: input.refillLambda },
          { note: `lambda update: ${priorLambda} → ${input.refillLambda}` },
        );
        bumpedVersionId = newVersion.id;
      }

      return { ok: true, bumped: bumpedVersionId !== null, refillVersionId: bumpedVersionId };
    });
  }),
});
