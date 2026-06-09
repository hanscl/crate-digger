import * as nodeCron from "node-cron";
import type { Database } from "@/db/client";
import type { Env } from "./env";
import { runDailyPipeline } from "./pipeline-run";

/**
 * In-process node-cron registry. Keeps the schedule deterministic and
 * boots inside the same Hono process as everything else — no separate worker
 * tier, no message broker, no Inngest. Per the spec: single Linux box,
 * single command.
 *
 * Two jobs:
 *
 *   1. `daily-pipeline` — 03:00 server-local. Runs the full
 *      ingest→enrich→bucket→retrain→recommend→surface chain via the Mastra
 *      workflow. The workflow's per-day cap + queue ceiling guard the user
 *      from waking up to a 500-item queue.
 *
 *   2. `keepalive` — every 6 hours. A trivial heartbeat used for log
 *      observability when something goes wrong with the daily run.
 *
 * Tests + reduced-env deployments can disable scheduling via
 * `CRON_DISABLED=1` — the registry still exposes `runDailyPipelineNow` for
 * manual triggers.
 *
 * Pipeline runs — scheduled here or fired from the Console — all go through
 * `runDailyPipeline` (`src/server/pipeline-run.ts`), which serializes them so
 * an overlapping manual run can't interleave with the 03:00 one.
 */

export type CronHandle = {
  stop: () => void;
  /** Manually fire the daily pipeline (Console "Run now" button uses this). */
  runDailyPipelineNow: () => Promise<void>;
};

const DAILY_CRON = "0 3 * * *"; // 03:00 every day, server-local
const KEEPALIVE_CRON = "0 */6 * * *"; // every 6 hours

export function startCron(deps: { db: Database; env: Env }): CronHandle {
  const tasks: { stop: () => void }[] = [];

  const cronDisabled = deps.env.CRON_DISABLED;
  const disabled = cronDisabled === "1" || cronDisabled.toLowerCase() === "true";

  // Manual triggers need to observe failures, so the core path lets errors
  // propagate. The cron entry below wraps it in a catch so a single bad run
  // doesn't kill the schedule.
  const runDailyPipelineNow = async () => {
    const result = await runDailyPipeline(deps);
    // Mastra's `run.start()` resolves with `{status: "failed"}` rather than
    // rejecting, so manual callers must surface non-success themselves.
    if (result.status !== "success") {
      throw new Error(`daily-pipeline ended with status "${result.status}"`);
    }
  };

  const runDailyPipelineScheduled = async () => {
    try {
      await runDailyPipelineNow();
    } catch (err) {
      // Stack trace lands in the logger; observability lives outside the loop.
      console.error("[cron] daily-pipeline failed", err);
    }
  };

  if (!disabled) {
    const daily = nodeCron.schedule(DAILY_CRON, () => {
      void runDailyPipelineScheduled();
    });
    tasks.push({ stop: () => daily.stop() });

    const keepalive = nodeCron.schedule(KEEPALIVE_CRON, () => {
      console.log("[cron] keepalive", new Date().toISOString());
    });
    tasks.push({ stop: () => keepalive.stop() });

    console.log(`[cron] scheduled daily-pipeline (${DAILY_CRON}) + keepalive (${KEEPALIVE_CRON})`);
  } else {
    console.log("[cron] CRON_DISABLED set — schedules registered as no-ops");
  }

  return {
    stop: () => {
      for (const t of tasks) t.stop();
    },
    runDailyPipelineNow,
  };
}
