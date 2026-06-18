import { sql } from "drizzle-orm";
import { z } from "zod";
import { appConfig, searchRun } from "@/db/schema";
import { createDefaultRegistry } from "@/lib/ingestion";
import type { PullMode, PullParams, SourceId } from "@/lib/ingestion";
import { protectedProcedure, router } from "../trpc-base";

/**
 * Sources router — backs the Sources screen (#05). Lists registered adapters
 * with availability + enabled state, lets the user toggle them, and provides
 * a `testFetch` so they can sanity-check credentials without waiting for the
 * daily pipeline.
 */

const SOURCE_ID = z.enum([
  "spotify",
  "lastfm",
  "viberate",
  "tiktok",
  "chartmetric",
]) satisfies z.ZodType<SourceId>;
const PULL_MODE = z.enum(["trending", "similar", "search"]) satisfies z.ZodType<PullMode>;

// ReccoBeats is an enrichment provider, not a `SourceAdapter` (it does not
// pull candidates), so it is not a `SourceId`. The toggle still writes the
// same `sources_enabled` jsonb, so its enum is widened to include it;
// `testFetch` keeps the narrow `SOURCE_ID` (search_run.source is enum-typed).
const TOGGLE_ID = z.enum(["spotify", "lastfm", "viberate", "tiktok", "chartmetric", "reccobeats"]);

export const sourcesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const registry = createDefaultRegistry();
    const [cfg] = await ctx.db
      .select({ sourcesEnabled: appConfig.sourcesEnabled })
      .from(appConfig)
      .limit(1);
    const enabled = cfg?.sourcesEnabled ?? {};
    return {
      adapters: registry.list().map((adapter) => ({
        id: adapter.id,
        isPaid: adapter.isPaid,
        isAvailable: adapter.isAvailable(ctx.appEnv),
        enabled: enabled[adapter.id] !== false,
      })),
      // Enrichment providers — not ingestion adapters. ReccoBeats supplies
      // audio features (no API key required).
      enrichment: [
        {
          id: "reccobeats" as const,
          label: "ReccoBeats",
          description: "Audio-feature enrichment. No API key required.",
          enabled: enabled.reccobeats !== false,
        },
      ],
    };
  }),

  toggle: protectedProcedure
    .input(z.object({ id: TOGGLE_ID, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // Read prior sourcesEnabled and upsert in a single transaction with FOR
      // UPDATE on the singleton row, matching params.update. Without this,
      // concurrent toggles can read the same prior map and the second write
      // clobbers the first toggle's flip. Seed the row first so FOR UPDATE
      // has something to lock when the table is empty (cold install).
      await ctx.db.transaction(async (tx) => {
        await tx.insert(appConfig).values({ id: 1 }).onConflictDoNothing();
        const [cfg] = await tx
          .select({ sourcesEnabled: appConfig.sourcesEnabled })
          .from(appConfig)
          .for("update")
          .limit(1);
        const next = { ...cfg?.sourcesEnabled, [input.id]: input.enabled };
        await tx
          .insert(appConfig)
          .values({ id: 1, sourcesEnabled: next })
          .onConflictDoUpdate({
            target: appConfig.id,
            set: { sourcesEnabled: next, updatedAt: sql`NOW()` },
          });
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
      if (!adapter.isAvailable(ctx.appEnv)) {
        return { ok: false, error: "missing credentials", count: 0 };
      }
      const trimmedQuery = input.query?.trim() ?? "";
      if (input.mode === "search" && trimmedQuery.length === 0) {
        return { ok: false, error: "missing query for search mode", count: 0 };
      }
      if (input.mode === "similar" && trimmedQuery.length === 0) {
        return {
          ok: false,
          error: "missing query for similar mode (use 'artist — track')",
          count: 0,
        };
      }
      let params: PullParams;
      if (input.mode === "search") {
        params = { mode: "search", query: trimmedQuery, limit: input.limit };
      } else if (input.mode === "trending") {
        params = { mode: "trending", limit: input.limit };
      } else {
        const parts = trimmedQuery.split(" — ");
        const artist = parts[0]?.trim() ?? "";
        const track = parts[1]?.trim() ?? "";
        if (parts.length !== 2 || artist.length === 0 || track.length === 0) {
          return {
            ok: false,
            error: "invalid query for similar mode; expected 'artist — track'",
            count: 0,
          };
        }
        params = { mode: "similar", seedArtist: artist, seedTrack: track, limit: input.limit };
      }
      const [run] = await ctx.db
        .insert(searchRun)
        .values({
          source: input.id,
          params,
          startedAt: new Date(),
        })
        .returning({ id: searchRun.id });
      if (!run) {
        return { ok: false, error: "failed to log search_run", count: 0 };
      }
      // try/finally so the search_run row always closes out, even when the
      // adapter throws — keeps the audit trail consistent with the daily pipeline.
      let candidates: Awaited<ReturnType<typeof adapter.pullCandidates>> = [];
      try {
        candidates = await adapter.pullCandidates(params, ctx.appEnv);
      } finally {
        await ctx.db
          .update(searchRun)
          .set({
            countPulled: candidates.length,
            finishedAt: new Date(),
          })
          .where(sql`${searchRun.id} = ${run.id}`);
      }
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
