import type { Database } from "@/db/client";
import { mastra } from "@/mastra";
import { buildRequestContext } from "@/mastra/runtime";
import type { DailyPipelineOutputT } from "@/mastra/workflows/daily-pipeline";
import type { Env } from "./env";

/**
 * Single entry point for daily-pipeline runs. BOTH trigger sites — the 03:00
 * cron schedule and the Console "Run now" mutation — must start runs through
 * here: runs are serialized behind an in-process queue so two pipelines never
 * interleave. Surfacing's eligibility gate and queue-ceiling check are
 * read-then-write against live tables with no DB-level lock; overlapping runs
 * could both pass the gate for the same track before either writes its
 * surface_event, producing duplicate queue cards. The whole app is one
 * process (single-box spec), so an in-process mutex suffices — no advisory
 * lock needed.
 */

export type DailyPipelineRunSummary = {
  status: string;
  /** The workflow's full output on success; null on any other terminal status. */
  output: DailyPipelineOutputT | null;
};

let tail: Promise<unknown> = Promise.resolve();

export function runDailyPipeline(deps: {
  db: Database;
  env: Env;
}): Promise<DailyPipelineRunSummary> {
  const run = tail.then(() => startRun(deps));
  // The queue must advance even when a run rejects; callers still observe the
  // rejection through the promise returned below.
  tail = run.catch(() => undefined);
  return run;
}

async function startRun(deps: { db: Database; env: Env }): Promise<DailyPipelineRunSummary> {
  const requestContext = buildRequestContext(deps);
  const workflow = mastra.getWorkflow("dailyPipeline");
  const run = await workflow.createRun();
  // Mastra's per-run RequestContext type is unknown-keyed; we narrow to our
  // typed shape inside step handlers via the `getDb` / `getEnv` helpers in
  // `src/mastra/runtime.ts`.
  const result = await run.start({
    inputData: {},
    requestContext: requestContext as unknown as Parameters<typeof run.start>[0]["requestContext"],
  });
  const output = result.status === "success" ? result.result : null;
  // The completion line carries the surfacing counters: the cron path has no
  // other sink for the workflow output (no Mastra storage is configured).
  console.log("[pipeline] daily-pipeline finished", {
    status: result.status,
    surfacedCount: output?.surfacedCount,
    effectiveCap: output?.effectiveCap,
    excludedDecidedCount: output?.excludedDecidedCount,
    excludedPendingCount: output?.excludedPendingCount,
  });
  return { status: result.status, output };
}
