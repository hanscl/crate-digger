import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  bucket,
  bucketMember,
  type NewRating,
  rating,
  type Rating,
  type RatingDecision,
  surfaceEvent,
} from "@/db/schema";
import { ensureActiveModelVersionInTx } from "@/lib/ranking/version";

/**
 * Constraint #3 (ratings tag the surface-time model_version): the version
 * stamped on a rating row is the version under which the track was SURFACED,
 * not whichever version is currently active when the user clicks. This is
 * what makes counterfactual replay meaningful — a v3 rating tells you "the
 * user kept this when v3's ranker chose it," and rolling forward to v6
 * doesn't retroactively re-attribute that decision.
 *
 * Implementation: when a `surfaceEventId` is provided we read the version id
 * off that event row (single source of truth — surfacing pinned it at write
 * time). When the rating arrives without a surface event (cold-start imports,
 * manual user search, taste-profile import), we fall back to the active
 * version so the rating still carries a valid foreign key.
 *
 * Side effects beyond the rating row:
 *   - Dislike: if the track is a bucket member, bump that bucket's
 *     `dislike_count`. The Phase 5 split heuristic reads this to surface
 *     "this bucket is mixing keeps with dislikes" recommendations.
 *   - Keep / defer / neutral: no bucket-side effect. Bucket centroid + feature
 *     stats are already updated at assignment time (Phase 3).
 */

export type IngestRatingInput = {
  trackId: number;
  decision: RatingDecision;
  /** Surface event the user is reacting to. Required for Constraint #3 attribution. */
  surfaceEventId?: number | null;
  /** Optional override — used by import flows. Ignored when surfaceEventId is set. */
  modelVersionId?: number;
};

export type IngestRatingResult = {
  rating: Rating;
  bucketDislikeIncremented: boolean;
};

export async function ingestRating(
  db: Database,
  input: IngestRatingInput,
): Promise<IngestRatingResult> {
  return db.transaction(async (tx) => {
    let resolvedVersionId: number | undefined;

    if (input.surfaceEventId !== undefined && input.surfaceEventId !== null) {
      const [se] = await tx
        .select({ modelVersionId: surfaceEvent.modelVersionId })
        .from(surfaceEvent)
        .where(eq(surfaceEvent.id, input.surfaceEventId))
        .limit(1);
      if (!se) {
        throw new Error(
          `ingestRating: surface_event id=${input.surfaceEventId} not found — cannot attribute version`,
        );
      }
      resolvedVersionId = se.modelVersionId;
    } else if (input.modelVersionId !== undefined) {
      resolvedVersionId = input.modelVersionId;
    } else {
      // Cold-start path: no surface event yet (e.g., the very first rating in
      // a fresh install), and the caller didn't pin a version. Bootstrap the
      // active broad version — it's the chain that retrain consumes. Reuse
      // the ambient tx so the bootstrap rolls back with the rating insert if
      // anything below fails.
      const v = await ensureActiveModelVersionInTx(tx, "broad");
      resolvedVersionId = v.id;
    }

    const insert: NewRating = {
      trackId: input.trackId,
      decision: input.decision,
      modelVersionId: resolvedVersionId,
      surfaceEventId: input.surfaceEventId ?? null,
    };
    const [row] = await tx.insert(rating).values(insert).returning();
    if (!row) throw new Error("ingestRating: insert returned no rows");

    let bucketDislikeIncremented = false;
    if (input.decision === "dislike") {
      const [member] = await tx
        .select({ bucketId: bucketMember.bucketId })
        .from(bucketMember)
        .where(eq(bucketMember.trackId, input.trackId))
        .limit(1);
      if (member) {
        // Only count the FIRST dislike per track. dislikeCount feeds the split
        // heuristic as `dislikeCount / memberCount` — counting repeat dislikes
        // (same track surfaced + disliked across multiple events) would inflate
        // the rate above 1.0 and corrupt bucket purity. We check for a prior
        // dislike on this track other than the row we just inserted.
        const [prior] = await tx
          .select({ id: rating.id })
          .from(rating)
          .where(
            and(
              eq(rating.trackId, input.trackId),
              eq(rating.decision, "dislike"),
              ne(rating.id, row.id),
            ),
          )
          .limit(1);
        if (!prior) {
          await tx
            .update(bucket)
            .set({ dislikeCount: sql`${bucket.dislikeCount} + 1`, updatedAt: sql`NOW()` })
            .where(eq(bucket.id, member.bucketId));
          bucketDislikeIncremented = true;
        }
      }
    }

    return { rating: row, bucketDislikeIncremented };
  });
}
