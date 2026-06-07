import { asc, desc, eq, gte } from "drizzle-orm";
import type { Database } from "@/db/client";
import { bucket, bucketMember, track } from "@/db/schema";
import { cosine } from "@/lib/embedding";

/**
 * A taste seed extracted from a bucket: the artist/title of the bucket's
 * centroid-nearest member, ready to feed a `mode: "similar"` adapter pull
 * (Last.fm `track.getSimilar`).
 */
export type BucketSeed = {
  bucketId: number;
  seedArtist: string;
  seedTrack: string;
};

export type SelectBucketSeedsOptions = {
  /** Top-N buckets (by member count) to seed from. */
  maxBuckets?: number;
};

/** Default number of top buckets to seed similar pulls from. */
export const DEFAULT_MAX_SEED_BUCKETS = 5;

/**
 * Deterministic bucket-seed selection for the taste-seeded "similar" pull
 * (LAB-39). Pure: no LLM, no network — just reads `bucket` / `bucket_member`
 * / `track` and ranks by cosine distance to the bucket centroid.
 *
 * Ordering / limit (held stable so a later refill-cursor — LAB-38 — can
 * inject rotation here without disturbing the rest of the pipeline):
 *
 *   1. Buckets are ordered `member_count DESC, id ASC` (stable tiebreak) and
 *      truncated to `maxBuckets` (default {@link DEFAULT_MAX_SEED_BUCKETS}),
 *      requiring `member_count >= 1`.
 *   2. Within each bucket, the member whose `track.embedding` is closest to
 *      the bucket `centroid` (max cosine) is the exemplar; ties broken by
 *      `track.id ASC` for determinism.
 *   3. Members without an embedding are ignored. Buckets with no embedded
 *      members, or whose exemplar has a blank artist/title, are skipped.
 *
 * Returns one `{ bucketId, seedArtist, seedTrack }` per surviving bucket,
 * in the bucket ordering above.
 */
export async function selectBucketSeeds(
  db: Database,
  opts: SelectBucketSeedsOptions = {},
): Promise<BucketSeed[]> {
  const maxBuckets = opts.maxBuckets ?? DEFAULT_MAX_SEED_BUCKETS;
  if (maxBuckets <= 0) return [];

  // `bucket.centroid` is `vector(64).notNull()` in the schema, so there's no
  // need for an `isNotNull(centroid)` guard. The `member_count >= 1` filter
  // documents the "non-empty buckets only" intent in code (the empty-members
  // skip below would catch it anyway, but the query shouldn't even consider
  // them).
  const topBuckets = await db
    .select({ id: bucket.id, centroid: bucket.centroid })
    .from(bucket)
    .where(gte(bucket.memberCount, 1))
    .orderBy(desc(bucket.memberCount), asc(bucket.id))
    .limit(maxBuckets);

  const seeds: BucketSeed[] = [];

  for (const b of topBuckets) {
    const members = await db
      .select({
        trackId: track.id,
        artist: track.artist,
        title: track.title,
        embedding: track.embedding,
      })
      .from(bucketMember)
      .innerJoin(track, eq(track.id, bucketMember.trackId))
      .where(eq(bucketMember.bucketId, b.id))
      .orderBy(asc(track.id));

    let best: { artist: string; title: string; sim: number } | null = null;
    for (const m of members) {
      if (!m.embedding) continue;
      const sim = cosine(m.embedding, b.centroid);
      // Strictly-greater keeps the first (lowest track.id) member on ties,
      // since `members` is ordered by track.id ASC.
      if (!best || sim > best.sim) {
        best = { artist: m.artist, title: m.title, sim };
      }
    }

    if (!best) continue;
    if (best.artist.length === 0 || best.title.length === 0) continue;

    seeds.push({ bucketId: b.id, seedArtist: best.artist, seedTrack: best.title });
  }

  return seeds;
}
