import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import type { Database } from "@/db/client";
import type { Env } from "./env";

/**
 * tRPC primitives, isolated from router composition.
 *
 * `trpc.ts` imports every per-screen router to assemble `appRouter`, and each
 * router needs `router` / `protectedProcedure` to define itself. Exporting
 * those from `trpc.ts` would form an import cycle: when ESM evaluates
 * `trpc.ts` it loads the routers first, and they would read `router` before
 * `trpc.ts`'s body had initialized it (temporal dead zone). Keeping the
 * primitives here — a module that imports no routers — breaks the cycle.
 */

/**
 * `appEnv` (not `env`) because `@hono/trpc-server` unconditionally overrides
 * the `env` key on every tRPC context with Hono's runtime env (which on Node
 * is `{ incoming, outgoing }`). Naming our app env `appEnv` dodges the clash.
 */
export type Context = {
  db: Database;
  appEnv: Env;
  isAuthenticated: boolean;
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      cause: error.cause instanceof z.ZodError ? z.treeifyError(error.cause) : undefined,
    },
  }),
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireAuth = t.middleware(({ ctx, next }) => {
  if (!ctx.isAuthenticated) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx });
});

export const protectedProcedure = t.procedure.use(requireAuth);
