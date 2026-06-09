import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { bucket, bucketMember, rating, track } from "@/db/schema";
import { addFeatureSample, emptyFeatureStats } from "./centroid";
import type { Tx } from "./assign";

/**
 * Rebuild a bucket's derived state from its CURRENT members: centroid (mean
 * of member embeddings), feature_stats (Welford, re-folded from scratch —
 * cheap at our scale, a bucket holds tens of members at most), member_count,
 * and dislike_count. A bucket left with zero members is DELETED — an empty
 * bucket has no geometry and nothing to refill (FK fallout: surface_event
 * .bucket_id and track.candidate_bucket_id null out; bucket_recommendation
 * .bucket_ids is a plain int[] with no FK, so callers that prune buckets must
 * clean stale recommendation rows themselves).
 *
 * Shared by the merge-accept path (buckets router) and the LAB-61 reconcile
 * sweep. Runs inside the caller's transaction.
 */
export async function recomputeBucketStats(tx: Database | Tx, bucketId: number): Promise<void> {
  const members = await tx
    .select({
      embedding: track.embedding,
      audioFeatures: track.audioFeatures,
    })
    .from(bucketMember)
    .innerJoin(track, eq(track.id, bucketMember.trackId))
    .where(eq(bucketMember.bucketId, bucketId));

  if (members.length === 0) {
    await tx.delete(bucket).where(eq(bucket.id, bucketId));
    return;
  }

  // Derive the centroid dimension from the first member that actually has an
  // embedding — `members[0]` may have `embedding = null`, which would force
  // the fallback dim and silently truncate later real embeddings.
  const firstEmbedding = members.find((m) => m.embedding && m.embedding.length > 0)?.embedding;
  const dim = firstEmbedding?.length ?? 64;
  const centroid = Array.from({ length: dim }, () => 0);
  let n = 0;
  for (const m of members) {
    if (!m.embedding) continue;
    for (let i = 0; i < dim; i++) centroid[i]! += m.embedding[i] ?? 0;
    n += 1;
  }
  if (n > 0) {
    for (let i = 0; i < dim; i++) centroid[i] = centroid[i]! / n;
  }
  // We rebuild Welford from scratch since the membership changed. Cheap at
  // our scale (a bucket holds tens of members at most).
  let stats = emptyFeatureStats();
  for (const m of members) {
    if (!m.audioFeatures) continue;
    stats = addFeatureSample(stats, m.audioFeatures);
  }

  // dislike_count is the number of distinct tracks currently in this bucket
  // that have at least one dislike rating. Recompute it from the current
  // members so the bucket's purity LED reflects inherited dislikes instead
  // of a stale pre-change tally.
  const [dislikeRow] = await tx
    .select({ dislikes: sql<number>`count(distinct ${rating.trackId})::int` })
    .from(bucketMember)
    .innerJoin(rating, eq(rating.trackId, bucketMember.trackId))
    .where(and(eq(bucketMember.bucketId, bucketId), eq(rating.decision, "dislike")));
  const dislikeCount = Number(dislikeRow?.dislikes ?? 0);

  await tx
    .update(bucket)
    .set({
      centroid,
      featureStats: stats,
      memberCount: members.length,
      dislikeCount,
      updatedAt: sql`NOW()`,
    })
    .where(eq(bucket.id, bucketId));
}
