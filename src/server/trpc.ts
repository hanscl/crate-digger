import { bucketsRouter } from "./routers/buckets";
import { evalsRouter } from "./routers/evals";
import { paramsRouter } from "./routers/params";
import { pipelineRouter } from "./routers/pipeline";
import { queueRouter } from "./routers/queue";
import { setupRouter } from "./routers/setup";
import { sourcesRouter } from "./routers/sources";
import { tasteRouter } from "./routers/taste";
import { publicProcedure, router } from "./trpc-base";

export type { Context } from "./trpc-base";

export const appRouter = router({
  ping: publicProcedure.query(() => ({ ok: true, ts: new Date().toISOString() })),
  me: publicProcedure.query(({ ctx }) => ({ authenticated: ctx.isAuthenticated })),
  queue: queueRouter,
  buckets: bucketsRouter,
  evals: evalsRouter,
  params: paramsRouter,
  pipeline: pipelineRouter,
  sources: sourcesRouter,
  setup: setupRouter,
  taste: tasteRouter,
});

export type AppRouter = typeof appRouter;
