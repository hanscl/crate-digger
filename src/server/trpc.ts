import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import type { Database } from "@/db/client";
import type { Env } from "./env";

export type Context = {
  db: Database;
  env: Env;
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

export const appRouter = router({
  ping: publicProcedure.query(() => ({ ok: true, ts: new Date().toISOString() })),
  me: protectedProcedure.query(({ ctx }) => ({ authenticated: ctx.isAuthenticated })),
});

export type AppRouter = typeof appRouter;
