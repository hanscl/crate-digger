import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { getDb, getEnv } from "@/mastra/runtime";
import {
  bucketAndName,
  pullAndEnrichTrending,
  recommendationsStep,
  renameEligibleBuckets,
  retrainStep,
  surfaceStep,
} from "@/mastra/lib/pipeline-steps";

/**
 * Daily pipeline workflow. Threaded together via `.then()`; each step takes
 * the running accumulator and returns it with its own field group filled in.
 * Re-using the accumulator as both input + output schema is what lets the
 * chain compose without `.map()` shims between every step.
 *
 * Cron-driven: `node-cron` calls `mastra.getWorkflow('dailyPipeline')` at
 * 03:00 local. Manual triggers from the Console screen will call the same
 * entry point with the same input shape.
 */

const PullEnrichResult = z.object({
  pulledCount: z.number().int().nonnegative(),
  resolvedTrackIds: z.array(z.number().int()),
  audioFeaturesUpdated: z.number().int().nonnegative(),
  genresUpdated: z.number().int().nonnegative(),
});

const BucketResult = z.object({
  spawnedBucketIds: z.array(z.number().int()),
  joinedBucketIds: z.array(z.number().int()),
});

const RenameResult = z.object({
  /** Buckets the rename step's eligibility rule accepted (LAB-25). */
  eligibleBucketCount: z.number().int().nonnegative(),
  /** Buckets the agent successfully renamed in this run. */
  renamedBucketCount: z.number().int().nonnegative(),
  /** Eligible buckets the namer failed on. */
  renameErrorCount: z.number().int().nonnegative(),
});

const RetrainResult = z.object({
  retrainSkipped: z.boolean(),
  retrainSkipReason: z.enum(["no_samples", "single_class"]).nullable(),
  retrainSampleCount: z.number().int().nonnegative(),
  newBroadVersionId: z.number().int().nullable(),
});

const RecommendationsResult = z.object({
  newMergeCount: z.number().int().nonnegative(),
  newSplitCount: z.number().int().nonnegative(),
  pendingRecommendationCount: z.number().int().nonnegative(),
});

const SurfaceResult = z.object({
  surfacedCount: z.number().int().nonnegative(),
  refillCount: z.number().int().nonnegative(),
  broadCount: z.number().int().nonnegative(),
  effectiveCap: z.number().int().nonnegative(),
});

export const DailyPipelineInput = z.object({
  /** Per-source pull cap; respected by adapters that have it. Default 25. */
  limitPerSource: z.number().int().positive().optional(),
});
export type DailyPipelineInputT = z.infer<typeof DailyPipelineInput>;

export const DailyPipelineAccumulator = DailyPipelineInput.extend({})
  .merge(PullEnrichResult.partial())
  .merge(BucketResult.partial())
  .merge(RenameResult.partial())
  .merge(RetrainResult.partial())
  .merge(RecommendationsResult.partial())
  .merge(SurfaceResult.partial());

export const DailyPipelineOutput = DailyPipelineInput.extend({})
  .merge(PullEnrichResult)
  .merge(BucketResult)
  .merge(RenameResult)
  .merge(RetrainResult)
  .merge(RecommendationsResult)
  .merge(SurfaceResult);

export type DailyPipelineOutputT = z.infer<typeof DailyPipelineOutput>;

const pullStep = createStep({
  id: "pull-and-enrich",
  inputSchema: DailyPipelineAccumulator,
  outputSchema: DailyPipelineAccumulator,
  execute: async ({ inputData, requestContext }) => {
    const db = getDb(requestContext);
    const env = getEnv(requestContext);
    const result = await pullAndEnrichTrending(db, env, {
      limitPerSource: inputData.limitPerSource,
    });
    return {
      ...inputData,
      pulledCount: result.pulledCount,
      resolvedTrackIds: result.resolvedTrackIds,
      audioFeaturesUpdated: result.audioFeaturesUpdated,
      genresUpdated: result.genresUpdated,
    };
  },
});

const bucketStep = createStep({
  id: "bucket-and-name",
  inputSchema: DailyPipelineAccumulator,
  outputSchema: DailyPipelineAccumulator,
  execute: async ({ inputData, requestContext }) => {
    const db = getDb(requestContext);
    const env = getEnv(requestContext);
    const result = await bucketAndName(db, env, inputData.resolvedTrackIds ?? []);
    return {
      ...inputData,
      spawnedBucketIds: result.spawnedBucketIds,
      joinedBucketIds: result.joinedBucketIds,
    };
  },
});

/**
 * LAB-25: lazy + drift-triggered rename pass. Walks every bucket, applies
 * the eligibility rule (first-time at N≥3, doubled member count, or centroid
 * drift), and names eligible buckets via the `bucket-namer` agent. Runs
 * after assignment so any joins from the bucket step contribute to the
 * decision.
 */
const renameWorkflowStep = createStep({
  id: "rename-eligible",
  inputSchema: DailyPipelineAccumulator,
  outputSchema: DailyPipelineAccumulator,
  execute: async ({ inputData, requestContext }) => {
    const db = getDb(requestContext);
    const env = getEnv(requestContext);
    const result = await renameEligibleBuckets(db, env);
    return {
      ...inputData,
      eligibleBucketCount: result.eligibleCount,
      renamedBucketCount: result.renamedCount,
      renameErrorCount: result.errorCount,
    };
  },
});

const retrainWorkflowStep = createStep({
  id: "retrain-broad",
  inputSchema: DailyPipelineAccumulator,
  outputSchema: DailyPipelineAccumulator,
  execute: async ({ inputData, requestContext }) => {
    const db = getDb(requestContext);
    const result = await retrainStep(db);
    return {
      ...inputData,
      retrainSkipped: result.skipped,
      retrainSkipReason: result.skipReason,
      retrainSampleCount: result.sampleCount,
      newBroadVersionId: result.newBroadVersionId,
    };
  },
});

const recommendationsWorkflowStep = createStep({
  id: "recommendations",
  inputSchema: DailyPipelineAccumulator,
  outputSchema: DailyPipelineAccumulator,
  execute: async ({ inputData, requestContext }) => {
    const db = getDb(requestContext);
    const result = await recommendationsStep(db);
    return {
      ...inputData,
      newMergeCount: result.newMergeCount,
      newSplitCount: result.newSplitCount,
      pendingRecommendationCount: result.totalPending,
    };
  },
});

const surfaceWorkflowStep = createStep({
  id: "surface",
  inputSchema: DailyPipelineAccumulator,
  outputSchema: DailyPipelineOutput,
  execute: async ({ inputData, requestContext }) => {
    const db = getDb(requestContext);
    const result = await surfaceStep(db, inputData.resolvedTrackIds ?? []);
    // The output schema is the strict, fully-populated shape; merge defaults
    // for the (rare) case where an upstream step left a field undefined —
    // shouldn't happen, but the typed schema would otherwise reject the row.
    return {
      limitPerSource: inputData.limitPerSource,
      pulledCount: inputData.pulledCount ?? 0,
      resolvedTrackIds: inputData.resolvedTrackIds ?? [],
      audioFeaturesUpdated: inputData.audioFeaturesUpdated ?? 0,
      genresUpdated: inputData.genresUpdated ?? 0,
      spawnedBucketIds: inputData.spawnedBucketIds ?? [],
      joinedBucketIds: inputData.joinedBucketIds ?? [],
      eligibleBucketCount: inputData.eligibleBucketCount ?? 0,
      renamedBucketCount: inputData.renamedBucketCount ?? 0,
      renameErrorCount: inputData.renameErrorCount ?? 0,
      retrainSkipped: inputData.retrainSkipped ?? true,
      retrainSkipReason: inputData.retrainSkipReason ?? null,
      retrainSampleCount: inputData.retrainSampleCount ?? 0,
      newBroadVersionId: inputData.newBroadVersionId ?? null,
      newMergeCount: inputData.newMergeCount ?? 0,
      newSplitCount: inputData.newSplitCount ?? 0,
      pendingRecommendationCount: inputData.pendingRecommendationCount ?? 0,
      surfacedCount: result.surfacedCount,
      refillCount: result.refillCount,
      broadCount: result.broadCount,
      effectiveCap: result.effectiveCap,
    };
  },
});

export const dailyPipeline = createWorkflow({
  id: "dailyPipeline",
  inputSchema: DailyPipelineInput,
  outputSchema: DailyPipelineOutput,
})
  .then(pullStep)
  .then(bucketStep)
  .then(renameWorkflowStep)
  .then(retrainWorkflowStep)
  .then(recommendationsWorkflowStep)
  .then(surfaceWorkflowStep)
  .commit();
