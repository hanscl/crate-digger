import { count } from "drizzle-orm";
import { z } from "zod";
import { bucket, rating, track } from "@/db/schema";
import {
  seedBucketsFromSpotifyPlaylist,
  seedBucketsFromSpotifyTrackIds,
} from "@/lib/bucketing/cold-start";
import { parseSpotifyTrackRef } from "@/lib/ingestion/spotify";
import { isPaidSourceConfigured } from "@/server/env";
import { protectedProcedure, router } from "../trpc-base";

/**
 * Setup router — backs the Setup screen (#06). Reports configuration health
 * + handles the cold-start playlist flow.
 *
 * Spotify auth here is the simple Client Credentials flow (server-side keys
 * in `.env`); a full PKCE OAuth round-trip is out of scope for the MVP since
 * playlist fetching works against the public catalog with the same token.
 */

export const setupRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const [trackCount] = await ctx.db.select({ n: count() }).from(track);
    const [bucketCount] = await ctx.db.select({ n: count() }).from(bucket);
    const [ratingCount] = await ctx.db.select({ n: count() }).from(rating);
    return {
      spotifyConfigured:
        ctx.appEnv.SPOTIFY_CLIENT_ID.length > 0 && ctx.appEnv.SPOTIFY_CLIENT_SECRET.length > 0,
      lastfmConfigured: ctx.appEnv.LASTFM_API_KEY.length > 0,
      viberateConfigured: isPaidSourceConfigured(ctx.appEnv, "viberate"),
      anthropicConfigured: ctx.appEnv.ANTHROPIC_API_KEY.length > 0,
      counts: {
        tracks: Number(trackCount?.n ?? 0),
        buckets: Number(bucketCount?.n ?? 0),
        ratings: Number(ratingCount?.n ?? 0),
      },
    };
  }),

  seedFromPlaylist: protectedProcedure
    .input(z.object({ url: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await seedBucketsFromSpotifyPlaylist(ctx.db, ctx.appEnv, input.url);
      if (!result) {
        return {
          ok: false,
          error:
            "could not parse playlist URL or Spotify credentials are missing — check the Sources screen",
        };
      }
      return {
        ok: true,
        trackCount: result.trackCount,
        assignedCount: result.assignedCount,
        alreadyAssignedCount: result.alreadyAssignedCount,
        spawnedBucketCount: result.spawnedBuckets.length,
        joinedBucketCount: result.joinedBuckets.length,
      };
    }),

  seedFromTrackUrls: protectedProcedure
    .input(z.object({ urls: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const lines = input.urls.split(/\r?\n/);
      const parsed: string[] = [];
      let invalid = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const id = parseSpotifyTrackRef(trimmed);
        if (id) parsed.push(id);
        else invalid++;
      }
      if (parsed.length === 0) {
        return { ok: false, error: "no valid Spotify track URLs / URIs / IDs found" };
      }
      // Mirror the playlist path's implicit 2000-track ceiling
      // (SPOTIFY_PLAYLIST_MAX_PAGES * PAGE_SIZE) — each ID becomes one
      // sequential /tracks/{id} call, so an unbounded paste would chew
      // through the rate-limit window.
      if (parsed.length > 2000) {
        return { ok: false, error: `too many tracks (${parsed.length}); max 2000 per seed` };
      }
      const result = await seedBucketsFromSpotifyTrackIds(ctx.db, ctx.appEnv, parsed);
      if (!result) {
        return {
          ok: false,
          error: "Spotify credentials are missing — check the Sources screen",
        };
      }
      return {
        ok: true,
        inputCount: parsed.length,
        invalidCount: invalid,
        trackCount: result.trackCount,
        assignedCount: result.assignedCount,
        alreadyAssignedCount: result.alreadyAssignedCount,
        spawnedBucketCount: result.spawnedBuckets.length,
        joinedBucketCount: result.joinedBuckets.length,
      };
    }),
});
