import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appConfig,
  bucket,
  type Bucket,
  type BucketRecommendation,
  bucketRecommendation,
  type RecommendationStatus,
} from "@/db/schema";
import { cosine } from "@/lib/embedding";
import type { Tx } from "./assign";

/**
 * Merge / split recommendation heuristics. NEVER auto-applies — the admin
 * dashboard surfaces pending recommendations and the user accepts/dismisses
 * them. Constraint #7: writes are limited to config + manual confirmations.
 *
 * Heuristics:
 *
 *   - MERGE: any unordered bucket pair whose centroid cosine similarity is
 *     ≥ `app_config.mergeThreshold` (default 0.92). Same-genre is a soft
 *     prerequisite — buckets with different `primary_genre` won't merge even
 *     at high cosine, because cosine on the multi-hot genre dims keeps
 *     mixed-genre pairs close while the user's mental model treats them as
 *     distinct shelves.
 *
 *   - SPLIT: any bucket whose internal dislike rate
 *     (`dislike_count / member_count`) exceeds `app_config.splitDislikeRate`
 *     (default 0.5) AND has at least 4 members. Tiny buckets fluctuate too
 *     wildly to act on. Below 4 members, a single dislike trips the rate; we
 *     wait until there's a real signal.
 *
 * Idempotency: re-running the heuristics doesn't insert duplicates. Merges
 * are keyed by the sorted bucket-id pair; splits by the bucket id alone.
 * Existing PENDING rows on the same key are left untouched. RESOLVED rows
 * (accepted/dismissed) are also left alone — the user already decided once;
 * we don't keep re-suggesting the same thing.
 */

const FALLBACK_MERGE_THRESHOLD = 0.92;
const FALLBACK_SPLIT_DISLIKE_RATE = 0.5;
const MIN_MEMBERS_FOR_SPLIT = 4;

export type RecommendationOptions = {
  /** Override for the merge cosine threshold. Falls back to app_config. */
  mergeThreshold?: number;
  /** Override for the split dislike-rate threshold. Falls back to app_config. */
  splitDislikeRate?: number;
};

export type EvaluateRecommendationsResult = {
  merges: BucketRecommendation[];
  splits: BucketRecommendation[];
  /** All pending recommendations after this run — includes pre-existing rows
   *  the heuristic re-encountered, not just newly emitted ones. */
  totalPending: number;
};

export async function evaluateBucketRecommendations(
  db: Database | Tx,
  options: RecommendationOptions = {},
): Promise<EvaluateRecommendationsResult> {
  const [cfg] = await db
    .select({
      mergeThreshold: appConfig.mergeThreshold,
      splitDislikeRate: appConfig.splitDislikeRate,
    })
    .from(appConfig)
    .limit(1);
  const mergeThreshold = options.mergeThreshold ?? cfg?.mergeThreshold ?? FALLBACK_MERGE_THRESHOLD;
  const splitRate =
    options.splitDislikeRate ?? cfg?.splitDislikeRate ?? FALLBACK_SPLIT_DISLIKE_RATE;

  const buckets = await db.select().from(bucket);
  const merges = await emitMergeRecommendations(db, buckets, mergeThreshold);
  const splits = await emitSplitRecommendations(db, buckets, splitRate);
  const [pendingCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bucketRecommendation)
    .where(eq(bucketRecommendation.status, "pending"));
  return { merges, splits, totalPending: pendingCount?.n ?? 0 };
}

async function emitMergeRecommendations(
  db: Database | Tx,
  buckets: readonly Bucket[],
  mergeThreshold: number,
): Promise<BucketRecommendation[]> {
  if (buckets.length < 2) return [];
  const out: BucketRecommendation[] = [];
  for (let i = 0; i < buckets.length; i++) {
    for (let j = i + 1; j < buckets.length; j++) {
      const a = buckets[i];
      const b = buckets[j];
      if (!a || !b) continue;
      // Same primary_genre is required: cosine on the genre multi-hot keeps
      // pairs close even when the user clearly maintains them as separate
      // shelves. Without this guard `[indie-rock] + [folk]` could merge if
      // their audio dims drift together.
      if (a.primaryGenre !== b.primaryGenre) continue;
      const sim = cosine(a.centroid, b.centroid);
      if (sim < mergeThreshold) continue;
      const ids = [a.id, b.id].sort((x, y) => x - y);
      const created = await upsertRecommendation(db, {
        kind: "merge",
        bucketIds: ids,
        reason: { similarity: sim, threshold: mergeThreshold },
      });
      if (created) out.push(created);
    }
  }
  return out;
}

async function emitSplitRecommendations(
  db: Database | Tx,
  buckets: readonly Bucket[],
  splitRate: number,
): Promise<BucketRecommendation[]> {
  const out: BucketRecommendation[] = [];
  for (const b of buckets) {
    if (b.memberCount < MIN_MEMBERS_FOR_SPLIT) continue;
    const rate = b.dislikeCount / b.memberCount;
    if (rate < splitRate) continue;
    const created = await upsertRecommendation(db, {
      kind: "split",
      bucketIds: [b.id],
      reason: {
        memberCount: b.memberCount,
        dislikeCount: b.dislikeCount,
        dislikeRate: rate,
        threshold: splitRate,
      },
    });
    if (created) out.push(created);
  }
  return out;
}

type UpsertInput = {
  kind: "merge" | "split";
  bucketIds: number[];
  reason: Record<string, number>;
};

/**
 * Insert one PENDING recommendation iff there isn't already a row with the
 * same (kind, bucketIds) key — pending or resolved. Returns the inserted row,
 * or null when an existing row already covers this case (so the caller can
 * distinguish "newly recommended" from "already known").
 *
 * Race-safe: dedupe is enforced by the
 * `bucket_recommendation_kind_bucket_ids_unique_idx` unique index plus
 * ON CONFLICT DO NOTHING, so two concurrent evaluator runs cannot both
 * insert the same recommendation. RESOLVED rows (accepted/dismissed) are
 * also blocked by the same index — we don't keep re-suggesting once the
 * user has decided.
 */
async function upsertRecommendation(
  db: Database | Tx,
  input: UpsertInput,
): Promise<BucketRecommendation | null> {
  const inserted = await db
    .insert(bucketRecommendation)
    .values({
      kind: input.kind,
      bucketIds: input.bucketIds,
      reason: input.reason,
      status: "pending" satisfies RecommendationStatus,
    })
    .onConflictDoNothing({
      target: [bucketRecommendation.kind, bucketRecommendation.bucketIds],
    })
    .returning();
  return inserted[0] ?? null;
}

export async function listPendingRecommendations(db: Database): Promise<BucketRecommendation[]> {
  return db.select().from(bucketRecommendation).where(eq(bucketRecommendation.status, "pending"));
}
