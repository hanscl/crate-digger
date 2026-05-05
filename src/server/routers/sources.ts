import { sql } from "drizzle-orm";
import { z } from "zod";
import { appConfig, searchRun } from "@/db/schema";
import { createDefaultRegistry } from "@/lib/ingestion";
import type { PullMode, PullParams, SourceId } from "@/lib/ingestion";
import { protectedProcedure, router } from "../trpc";

/**
 * Sources router — backs the Sources screen (#05). Lists registered adapters
 * with availability + enabled state, lets the user toggle them, and provides
 * a `testFetch` so they can sanity-check credentials without waiting for the
 * daily pipeline.
 */

const SOURCE_ID = z.enum(["spotify", "lastfm", "viberate"]) satisfies z.ZodType<SourceId>;
const PULL_MODE = z.enum(["trending", "similar", "search"]) satisfies z.ZodType<PullMode>;

export const sourcesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const registry = createDefaultRegistry();
    const [cfg] = await ctx.db
      .select({ sourcesEnabled: appConfig.sourcesEnabled })
      .from(appConfig)
      .limit(1);
    const enabled = cfg?.sourcesEnabled ?? {};
    return registry.list().map((adapter) => ({
      id: adapter.id,
      isPaid: adapter.isPaid,
      isAvailable: adapter.isAvailable(ctx.env),
      enabled: enabled[adapter.id] !== false,
    }));
  }),

  toggle: protectedProcedure
    .input(z.object({ id: SOURCE_ID, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [cfg] = await ctx.db
        .select({ sourcesEnabled: appConfig.sourcesEnabled })
        .from(appConfig)
        .limit(1);
      const next = { ...cfg?.sourcesEnabled, [input.id]: input.enabled };
      await ctx.db
        .insert(appConfig)
        .values({ id: 1, sourcesEnabled: next })
        .onConflictDoUpdate({
          target: appConfig.id,
          set: { sourcesEnabled: next, updatedAt: sql`NOW()` },
        });
      return { ok: true };
    }),

  /**
   * Fire a one-off pull against the requested adapter. Doesn't write tracks —
   * it's a credential / connectivity smoke test. Logs a `search_run` row so
   * the audit trail lives next to the daily pipeline runs.
   */
  testFetch: protectedProcedure
    .input(
      z.object({
        id: SOURCE_ID,
        mode: PULL_MODE.default("trending"),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const adapter = createDefaultRegistry().get(input.id);
      if (!adapter) {
        return { ok: false, error: "unknown adapter", count: 0 };
      }
      if (!adapter.isAvailable(ctx.env)) {
        return { ok: false, error: "missing credentials", count: 0 };
      }
      const params: PullParams =
        input.mode === "search"
          ? { mode: "search", query: input.query ?? "", limit: input.limit }
          : input.mode === "trending"
            ? { mode: "trending", limit: input.limit }
            : input.query
              ? {
                  mode: "similar",
                  seedArtist: input.query.split(" — ")[0] ?? input.query,
                  seedTrack: input.query.split(" — ")[1] ?? input.query,
                  limit: input.limit,
                }
              : { mode: "trending", limit: input.limit };
      const [run] = await ctx.db
        .insert(searchRun)
        .values({
          source: input.id,
          params,
          startedAt: new Date(),
        })
        .returning({ id: searchRun.id });
      const candidates = await adapter.pullCandidates(params, ctx.env);
      await ctx.db
        .update(searchRun)
        .set({
          countPulled: candidates.length,
          finishedAt: new Date(),
        })
        .where(sql`${searchRun.id} = ${run!.id}`);
      return {
        ok: true,
        count: candidates.length,
        sample: candidates.slice(0, 5).map((c) => ({
          title: c.title,
          artist: c.artist,
          isrc: c.isrc,
          source: c.source,
        })),
      };
    }),
});
