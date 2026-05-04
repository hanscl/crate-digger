import * as nodeCron from "node-cron";
import type { Database } from "@/db/client";
import { buildRequestContext } from "@/mastra/runtime";
import { mastra } from "@/mastra";
import type { Env } from "./env";

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
 * manual triggers from the Console screen tRPC route.
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

  const disabled =
    process.env.CRON_DISABLED === "1" || process.env.CRON_DISABLED?.toLowerCase() === "true";

  const runDailyPipelineNow = async () => {
    try {
      const requestContext = buildRequestContext(deps);
      const workflow = mastra.getWorkflow("dailyPipeline");
      const run = await workflow.createRun();
      // Mastra's per-run RequestContext type is unknown-keyed; we narrow to
      // our typed shape inside step handlers via the `getDb` / `getEnv`
      // helpers in `src/mastra/runtime.ts`.
      const result = await run.start({
        inputData: {},
        requestContext: requestContext as unknown as Parameters<
          typeof run.start
        >[0]["requestContext"],
      });
      console.log("[cron] daily-pipeline finished", { status: result.status });
    } catch (err) {
      // Swallowing here keeps the cron schedule alive across one bad run.
      // Stack trace lands in the logger; observability lives outside the loop.
      console.error("[cron] daily-pipeline failed", err);
    }
  };

  if (!disabled) {
    const daily = nodeCron.schedule(DAILY_CRON, () => {
      void runDailyPipelineNow();
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
