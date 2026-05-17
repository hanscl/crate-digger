import { TRPCError } from "@trpc/server";
import { asc, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { bucket, rating, surfaceEvent, track } from "@/db/schema";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import { explainWhySurfaced } from "@/mastra/agents/why-surfaced";
import { protectedProcedure, router } from "../trpc-base";

/**
 * Queue router. Powers the Rating Queue screen (#01).
 *
 * `next` walks the FIFO of unrated surface events; `rate` writes a rating
 * via the deterministic ingest pipeline (Constraint #3 attribution lives
 * there). `why` produces a one-sentence explanation via the why-surfaced
 * agent — the agent has its own deterministic fallback when no API key is
 * configured, so this route always resolves.
 */

export const queueRouter = router({
  /**
   * Oldest-first unrated surface event. Returns null when the queue is empty.
   */
  next: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({
        eventId: surfaceEvent.id,
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        primaryGenre: track.primaryGenre,
        audioFeatures: track.audioFeatures,
        durationMs: track.durationMs,
        rankerKind: surfaceEvent.rankerKind,
        winnerScore: surfaceEvent.winnerScore,
        bucketId: surfaceEvent.bucketId,
        surfacedReason: surfaceEvent.surfacedReason,
        surfacedAt: surfaceEvent.surfacedAt,
        modelVersionId: surfaceEvent.modelVersionId,
        candidatePool: surfaceEvent.candidatePool,
      })
      .from(surfaceEvent)
      .innerJoin(track, eq(track.id, surfaceEvent.trackId))
      .leftJoin(rating, eq(rating.surfaceEventId, surfaceEvent.id))
      .where(isNull(rating.id))
      .orderBy(asc(surfaceEvent.surfacedAt), asc(surfaceEvent.id))
      .limit(1);
    if (!row) return null;

    let bucketName: string | null = null;
    let bucketColor: string | null = null;
    if (row.bucketId !== null) {
      const [b] = await ctx.db
        .select({ name: bucket.name, color: bucket.color })
        .from(bucket)
        .where(eq(bucket.id, row.bucketId))
        .limit(1);
      bucketName = b?.name ?? null;
      bucketColor = b?.color ?? null;
    }

    const winner = row.candidatePool.find((entry) => entry.surfaced);
    return {
      eventId: row.eventId,
      track: {
        id: row.trackId,
        title: row.title,
        artist: row.artist,
        album: row.album,
        primaryGenre: row.primaryGenre,
        audioFeatures: row.audioFeatures,
        durationMs: row.durationMs,
      },
      ranker: {
        kind: row.rankerKind,
        score: row.winnerScore,
        subScores: winner?.subScores ?? {},
        bucketId: row.bucketId,
        bucketName,
        bucketColor,
        surfacedReason: row.surfacedReason,
        modelVersionId: row.modelVersionId,
        poolSize: row.candidatePool.length,
        surfacedAt: row.surfacedAt,
      },
    };
  }),

  /**
   * Queue depth — count of unrated surface events. Drives the header counter.
   */
  depth: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({ unrated: count() })
      .from(surfaceEvent)
      .leftJoin(rating, eq(rating.surfaceEventId, surfaceEvent.id))
      .where(isNull(rating.id));
    return { unrated: Number(row?.unrated ?? 0) };
  }),

  /**
   * Recent rated events — used by the queue's "history" strip. Newest-first.
   */
  recent: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 20;
      const rows = await ctx.db
        .select({
          ratingId: rating.id,
          decision: rating.decision,
          ratedAt: rating.ratedAt,
          trackId: track.id,
          title: track.title,
          artist: track.artist,
        })
        .from(rating)
        .innerJoin(track, eq(track.id, rating.trackId))
        .orderBy(desc(rating.ratedAt), desc(rating.id))
        .limit(limit);
      return rows;
    }),

  /**
   * Submit a rating. The deterministic core picks up the surface event's
   * pinned `model_version_id` (Constraint #3) and the bucket dislike side
   * effect — this route is a thin auth/validation wrapper.
   */
  rate: protectedProcedure
    .input(
      z.object({
        eventId: z.number().int().positive(),
        decision: z.enum(["keep", "dislike", "defer", "neutral"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [event] = await ctx.db
        .select({ id: surfaceEvent.id, trackId: surfaceEvent.trackId })
        .from(surfaceEvent)
        .where(eq(surfaceEvent.id, input.eventId))
        .limit(1);
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "surface event not found" });
      }
      const result = await ingestRating(ctx.db, {
        trackId: event.trackId,
        decision: input.decision,
        surfaceEventId: event.id,
      });
      return {
        ratingId: result.rating.id,
        decision: result.rating.decision,
        bucketDislikeIncremented: result.bucketDislikeIncremented,
      };
    }),

  /**
   * Manual rate-by-track for cold-start use. The active broad version anchors
   * the rating; no surface event recorded.
   */
  rateTrack: protectedProcedure
    .input(
      z.object({
        trackId: z.number().int().positive(),
        decision: z.enum(["keep", "dislike", "defer", "neutral"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Mirror `rate`: reject up front instead of letting the FK error from
      // ingest-rating surface as an opaque 500.
      const [t] = await ctx.db
        .select({ id: track.id })
        .from(track)
        .where(eq(track.id, input.trackId))
        .limit(1);
      if (!t) {
        throw new TRPCError({ code: "NOT_FOUND", message: "track not found" });
      }
      const result = await ingestRating(ctx.db, {
        trackId: input.trackId,
        decision: input.decision,
      });
      return { ratingId: result.rating.id };
    }),

  /**
   * Why-surfaced explanation. Always returns text — the agent falls back to a
   * deterministic line when the API key is unset (`src/mastra/agents/why-surfaced.ts`).
   */
  why: protectedProcedure
    .input(z.object({ eventId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({
          eventId: surfaceEvent.id,
          rankerKind: surfaceEvent.rankerKind,
          winnerScore: surfaceEvent.winnerScore,
          bucketId: surfaceEvent.bucketId,
          candidatePool: surfaceEvent.candidatePool,
          title: track.title,
          artist: track.artist,
          primaryGenre: track.primaryGenre,
        })
        .from(surfaceEvent)
        .innerJoin(track, eq(track.id, surfaceEvent.trackId))
        .where(eq(surfaceEvent.id, input.eventId))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "surface event not found" });
      }
      let bucketName: string | null = null;
      if (row.bucketId !== null) {
        const [b] = await ctx.db
          .select({ name: bucket.name })
          .from(bucket)
          .where(eq(bucket.id, row.bucketId))
          .limit(1);
        bucketName = b?.name ?? null;
      }
      const winner = row.candidatePool.find((entry) => entry.surfaced);
      const explanation = await explainWhySurfaced(
        {
          trackTitle: row.title,
          trackArtist: row.artist,
          primaryGenre: row.primaryGenre,
          rankerKind: row.rankerKind,
          bucketName,
          winnerScore: row.winnerScore,
          subScores: winner?.subScores,
          poolSize: row.candidatePool.length,
        },
        ctx.env,
      );
      return explanation;
    }),
});
