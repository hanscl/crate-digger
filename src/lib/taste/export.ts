import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { appConfig, bucket, bucketMember, rating, track } from "@/db/schema";
import type { TasteBucket, TasteExport, TasteRating } from "./schema";

/**
 * Snapshot the current taste profile to a JSON-shaped object. Constraint #8
 * requires this to round-trip cleanly into a wiped install via `importTaste`.
 *
 * Read-only; does not mutate any rows. The returned shape is the wire format
 * (`TasteExport`); callers serialize it with `JSON.stringify` themselves —
 * the lib doesn't decide on string vs object.
 */
export async function exportTaste(db: Database): Promise<TasteExport> {
  const [cfg] = await db.select().from(appConfig).limit(1);

  const buckets = await db.select().from(bucket).orderBy(bucket.id);
  const memberRows = await db
    .select({
      bucketId: bucketMember.bucketId,
      origin: bucketMember.origin,
      isrc: track.isrc,
      spotifyId: track.spotifyId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      genres: track.genres,
    })
    .from(bucketMember)
    .innerJoin(track, eq(track.id, bucketMember.trackId))
    .orderBy(bucketMember.bucketId, bucketMember.addedAt);

  const membersByBucket = new Map<number, TasteBucket["members"]>();
  for (const m of memberRows) {
    const list = membersByBucket.get(m.bucketId) ?? [];
    list.push({
      isrc: m.isrc,
      spotifyId: m.spotifyId,
      title: m.title,
      artist: m.artist,
      album: m.album ?? null,
      genres: m.genres,
      origin: m.origin,
    });
    membersByBucket.set(m.bucketId, list);
  }

  const exportedBuckets: TasteBucket[] = buckets.map((b) => ({
    name: b.name,
    color: b.color,
    primaryGenre: b.primaryGenre,
    isColdStartSeed: b.isColdStartSeed,
    members: membersByBucket.get(b.id) ?? [],
  }));

  const ratingRows = await db
    .select({
      decision: rating.decision,
      ratedAt: rating.ratedAt,
      isrc: track.isrc,
      spotifyId: track.spotifyId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      genres: track.genres,
    })
    .from(rating)
    .innerJoin(track, eq(track.id, rating.trackId))
    .orderBy(rating.ratedAt, rating.id);

  const exportedRatings: TasteRating[] = ratingRows.map((r) => ({
    decision: r.decision,
    ratedAt: r.ratedAt.toISOString(),
    track: {
      isrc: r.isrc,
      spotifyId: r.spotifyId,
      title: r.title,
      artist: r.artist,
      album: r.album ?? null,
      genres: r.genres,
    },
  }));

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    config: cfg
      ? {
          novelty: cfg.novelty,
          sourceMix: cfg.sourceMix,
          queueCeiling: cfg.queueCeiling,
          refillQualityBar: cfg.refillQualityBar,
          broadQualityBar: cfg.broadQualityBar,
          spawnThreshold: cfg.spawnThreshold,
          refillLambda: cfg.refillLambda,
          audioWeight: cfg.audioWeight,
          mergeThreshold: cfg.mergeThreshold,
          splitDislikeRate: cfg.splitDislikeRate,
          trendingLimitPerSource: cfg.trendingLimitPerSource,
          similarLimitPerSource: cfg.similarLimitPerSource,
          similarSeedBuckets: cfg.similarSeedBuckets,
          exploreLimitPerSource: cfg.exploreLimitPerSource,
          similarArtistCap: cfg.similarArtistCap,
          familiarArtistKeepThreshold: cfg.familiarArtistKeepThreshold,
          surfaceArtistCap: cfg.surfaceArtistCap,
        }
      : undefined,
    buckets: exportedBuckets,
    ratings: exportedRatings,
  };
}
