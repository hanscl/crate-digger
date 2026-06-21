import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import * as schema from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import { exportTaste } from "@/lib/taste/export";
import { importTaste } from "@/lib/taste/import";

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const PROVISION_TIMEOUT = 120_000;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("cratedigger_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  client = postgres(container.getConnectionUri(), {
    max: 5,
    prepare: false,
    onnotice: () => undefined,
  });
  await client.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, "../../migrations") });
}, PROVISION_TIMEOUT);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

async function wipe(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE ${schema.rating} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.surfaceEvent} RESTART IDENTITY CASCADE`);
  await db.execute(
    sql`UPDATE ${schema.appConfig} SET active_refill_version_id = NULL, active_broad_version_id = NULL`,
  );
  await db.execute(sql`TRUNCATE TABLE ${schema.modelVersion} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketMember} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucket} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
}

beforeEach(async () => {
  await wipe();
});

function audio(overrides: Partial<schema.AudioFeatures> = {}): schema.AudioFeatures {
  return {
    tempo: 120,
    energy: 0.5,
    valence: 0.5,
    danceability: 0.5,
    acousticness: 0.5,
    instrumentalness: 0.5,
    ...overrides,
  };
}

async function insertTrack(opts: {
  title: string;
  artist: string;
  isrc?: string | null;
  spotifyId?: string | null;
  audioFeatures: schema.AudioFeatures | null;
  genres: string[];
}): Promise<number> {
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: opts.artist,
      isrc: opts.isrc ?? null,
      spotifyId: opts.spotifyId ?? null,
      audioFeatures: opts.audioFeatures,
      genres: opts.genres,
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return row.id;
}

describe("taste profile export/import (Constraint #8)", () => {
  it("round-trips buckets + ratings cleanly through a full DB wipe", async () => {
    const a = await insertTrack({
      title: "Sunset",
      artist: "Artist A",
      isrc: "USABC1234567",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["indie rock"],
    });
    const b = await insertTrack({
      title: "Driver",
      artist: "Artist A",
      isrc: "USABC9999999",
      audioFeatures: audio({ tempo: 128 }),
      genres: ["indie rock"],
    });
    const c = await insertTrack({
      title: "Slow Hands",
      artist: "Artist B",
      spotifyId: "spotify:track:abc",
      audioFeatures: audio({ tempo: 70, valence: 0.2 }),
      genres: ["jazz"],
    });

    await assignTrack(db, a, { origin: "seed_track", spawnThreshold: 0.7 });
    await assignTrack(db, b, { origin: "seed_track", spawnThreshold: 0.7 });
    await assignTrack(db, c, { origin: "seed_track", spawnThreshold: 0.7 });

    // Rename the indie-rock bucket so the export carries non-default name/color.
    const bucketsBefore = await db.select().from(schema.bucket).orderBy(schema.bucket.id);
    expect(bucketsBefore.length).toBeGreaterThanOrEqual(2);
    // derivePrimaryGenre picks the longest matching keyword. For
    // ["indie rock"] both "rock" (4 chars) and "indie" (5 chars) match,
    // so the longer "indie" slot wins.
    const indieBucket = bucketsBefore.find((row) => row.primaryGenre === "indie");
    expect(indieBucket).toBeDefined();
    await db
      .update(schema.bucket)
      .set({ name: "Sunset Drives", color: "#22d3ee" })
      .where(sql`${schema.bucket.id} = ${indieBucket!.id}`);

    await ingestRating(db, { trackId: a, decision: "keep" });
    await ingestRating(db, { trackId: c, decision: "dislike" });

    const exportPayload = await exportTaste(db);
    expect(exportPayload.version).toBe(1);
    expect(exportPayload.buckets.length).toBe(bucketsBefore.length);
    const sunsetExported = exportPayload.buckets.find((bx) => bx.name === "Sunset Drives");
    expect(sunsetExported).toBeDefined();
    expect(sunsetExported!.members.map((m) => m.title).sort()).toEqual(["Driver", "Sunset"].sort());
    expect(exportPayload.ratings).toHaveLength(2);

    // Round-trip through JSON to catch anything that doesn't serialize.
    const wire = JSON.parse(JSON.stringify(exportPayload));

    await wipe();

    const result = await importTaste(db, wire);
    expect(result.bucketsCreated).toBe(bucketsBefore.length);
    expect(result.trackInserted).toBeGreaterThan(0);
    expect(result.membersAdded).toBe(3);
    expect(result.ratingsInserted).toBe(2);

    const reBuckets = await db.select().from(schema.bucket).orderBy(schema.bucket.id);
    expect(reBuckets.length).toBe(bucketsBefore.length);
    const reSunset = reBuckets.find((b) => b.name === "Sunset Drives");
    expect(reSunset?.color).toBe("#22d3ee");
    expect(reSunset?.memberCount).toBe(2);

    const reMembers = await db
      .select({ title: schema.track.title })
      .from(schema.bucketMember)
      .innerJoin(schema.track, sql`${schema.track.id} = ${schema.bucketMember.trackId}`)
      .where(sql`${schema.bucketMember.bucketId} = ${reSunset!.id}`);
    expect(reMembers.map((m) => m.title).sort()).toEqual(["Driver", "Sunset"]);

    const reRatings = await db.select().from(schema.rating).orderBy(schema.rating.id);
    expect(reRatings).toHaveLength(2);
    expect(reRatings.map((r) => r.decision).sort()).toEqual(["dislike", "keep"]);
    // Cold-start path: imported ratings carry no surface event.
    expect(reRatings.every((r) => r.surfaceEventId === null)).toBe(true);
    // ratedAt timestamps survive the round trip.
    expect(reRatings[0]!.ratedAt).toBeInstanceOf(Date);
  });

  it("rejects malformed payloads at the schema boundary", async () => {
    await expect(importTaste(db, { version: 99, buckets: [] })).rejects.toBeInstanceOf(ZodError);
    await expect(importTaste(db, "not an object")).rejects.toBeInstanceOf(ZodError);
  });

  it("matches existing tracks by ISRC instead of inserting duplicates", async () => {
    // Seed the destination DB with a track that shares an ISRC with the export.
    await insertTrack({
      title: "Existing",
      artist: "Artist",
      isrc: "USABC1111111",
      audioFeatures: audio(),
      genres: ["rock"],
    });

    const payload = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      buckets: [
        {
          name: "Imported Bucket",
          color: null,
          primaryGenre: "rock",
          isColdStartSeed: false,
          members: [
            {
              isrc: "USABC1111111",
              spotifyId: null,
              title: "Different title",
              artist: "Different artist",
              album: null,
              genres: ["rock"],
            },
          ],
        },
      ],
      ratings: [],
    };
    const result = await importTaste(db, payload);
    expect(result.trackInserted).toBe(0);
    expect(result.trackMatched).toBe(1);
    expect(result.bucketsCreated).toBe(1);
    expect(result.membersAdded).toBe(1);

    const allTracks = await db.select().from(schema.track);
    expect(allTracks).toHaveLength(1);
    expect(allTracks[0]!.title).toBe("Existing");
  });

  it("imports a pre-LAB-53 config block that lacks the quality bars (defaults applied)", async () => {
    // Backward-compat (LAB-53): a taste export produced before the quality bars
    // existed carries a config block without them. It must still import; the
    // bars fall back to the app_config column defaults (0.7 / 0.5).
    const payload = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      config: {
        novelty: 0.4,
        sourceMix: 0.6,
        queueCeiling: 42,
        spawnThreshold: 0.7,
        refillLambda: 0.3,
        mergeThreshold: 0.92,
        splitDislikeRate: 0.5,
        trendingLimitPerSource: 3,
        similarLimitPerSource: 3,
        similarSeedBuckets: 5,
        // no refillQualityBar / broadQualityBar — simulating a pre-LAB-53 export
      },
      buckets: [],
      ratings: [],
    };
    await importTaste(db, payload); // must not throw on the missing bars

    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.queueCeiling).toBe(42); // provided field applied
    expect(cfg?.refillQualityBar).toBe(0.7); // DB default
    expect(cfg?.broadQualityBar).toBe(0.5); // DB default
    // Pre-LAB-36 exports also lack audioWeight — same fallback rule.
    expect(cfg?.audioWeight).toBe(2.5); // DB default
  });

  it("round-trips audioWeight in the config block (LAB-36)", async () => {
    await db.insert(schema.appConfig).values({ id: 1, audioWeight: 3.5 });
    const exportPayload = await exportTaste(db);
    expect(exportPayload.config?.audioWeight).toBe(3.5);

    const wire = JSON.parse(JSON.stringify(exportPayload));
    await wipe();
    await importTaste(db, wire);

    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.audioWeight).toBe(3.5);
  });

  it("imports a pre-LAB-73 config block that lacks the artist-diversity knobs (defaults applied)", async () => {
    // Backward-compat (LAB-73): a taste export produced before the
    // artist-diversity knobs existed carries a config block without them. It
    // must still import; the knobs fall back to the app_config column defaults.
    const payload = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      config: {
        novelty: 0.4,
        sourceMix: 0.6,
        queueCeiling: 42,
        spawnThreshold: 0.7,
        refillLambda: 0.3,
        mergeThreshold: 0.92,
        splitDislikeRate: 0.5,
        trendingLimitPerSource: 3,
        similarLimitPerSource: 3,
        similarSeedBuckets: 5,
        // no similarArtistCap / familiarArtistKeepThreshold / surfaceArtistCap
      },
      buckets: [],
      ratings: [],
    };
    await importTaste(db, payload); // must not throw on the missing knobs

    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.queueCeiling).toBe(42); // provided field applied
    expect(cfg?.similarArtistCap).toBe(2); // DB default
    expect(cfg?.familiarArtistKeepThreshold).toBe(3); // DB default
    expect(cfg?.surfaceArtistCap).toBe(1); // DB default
  });

  it("round-trips the artist-diversity knobs in the config block (LAB-73)", async () => {
    await db.insert(schema.appConfig).values({
      id: 1,
      similarArtistCap: 1,
      familiarArtistKeepThreshold: 5,
      surfaceArtistCap: 2,
    });
    const exportPayload = await exportTaste(db);
    expect(exportPayload.config?.similarArtistCap).toBe(1);
    expect(exportPayload.config?.familiarArtistKeepThreshold).toBe(5);
    expect(exportPayload.config?.surfaceArtistCap).toBe(2);

    const wire = JSON.parse(JSON.stringify(exportPayload));
    await wipe();
    await importTaste(db, wire);

    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.similarArtistCap).toBe(1);
    expect(cfg?.familiarArtistKeepThreshold).toBe(5);
    expect(cfg?.surfaceArtistCap).toBe(2);
  });

  it("round-trips the explore pull throttle in the config block (LAB-40)", async () => {
    await db.insert(schema.appConfig).values({ id: 1, exploreLimitPerSource: 4 });
    const exportPayload = await exportTaste(db);
    expect(exportPayload.config?.exploreLimitPerSource).toBe(4);

    const wire = JSON.parse(JSON.stringify(exportPayload));
    await wipe();
    await importTaste(db, wire);

    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.exploreLimitPerSource).toBe(4);
  });

  it("imports a pre-LAB-40 config block that lacks the explore throttle (default applied)", async () => {
    await importTaste(db, {
      version: 1,
      exportedAt: new Date().toISOString(),
      config: {
        novelty: 0.5,
        sourceMix: 0.5,
        queueCeiling: 50,
        spawnThreshold: 0.7,
        refillLambda: 0.3,
        mergeThreshold: 0.92,
        splitDislikeRate: 0.5,
        trendingLimitPerSource: 3,
        similarLimitPerSource: 3,
        similarSeedBuckets: 5,
        // no exploreLimitPerSource
      },
      buckets: [],
      ratings: [],
    });
    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.exploreLimitPerSource).toBe(2); // DB default
  });
});

describe("taste profile — LAB-61 membership origin round-trip", () => {
  it("origin survives export → wipe → import", async () => {
    // One playlist-seeded member plus one discovery keep (the keep joins the
    // seed's bucket through the ingestRating approval path).
    const seed = await insertTrack({
      title: "Playlist seed",
      artist: "Artist A",
      isrc: "USABC0000001",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    await assignTrack(db, seed, {
      origin: "seed_playlist",
      spawnThreshold: 0.7,
      coldStartSeed: true,
    });
    const found = await insertTrack({
      title: "Discovery keep",
      artist: "Artist B",
      isrc: "USABC0000002",
      audioFeatures: audio({ tempo: 131 }),
      genres: ["rock"],
    });
    await ingestRating(db, { trackId: found, decision: "keep" });

    const exportPayload = await exportTaste(db);
    const members = exportPayload.buckets.flatMap((b) => b.members);
    expect(members.find((m) => m.isrc === "USABC0000001")?.origin).toBe("seed_playlist");
    expect(members.find((m) => m.isrc === "USABC0000002")?.origin).toBe("discovery_keep");

    const wire = JSON.parse(JSON.stringify(exportPayload));
    await wipe();
    await importTaste(db, wire);

    const reMembers = await db
      .select({ isrc: schema.track.isrc, origin: schema.bucketMember.origin })
      .from(schema.bucketMember)
      .innerJoin(schema.track, sql`${schema.track.id} = ${schema.bucketMember.trackId}`);
    expect(reMembers).toHaveLength(2);
    const byIsrc = new Map(reMembers.map((m) => [m.isrc, m.origin]));
    expect(byIsrc.get("USABC0000001")).toBe("seed_playlist");
    expect(byIsrc.get("USABC0000002")).toBe("discovery_keep");
  });

  it("imports a pre-LAB-61 export without member origins via the keep-inference fallback", async () => {
    // Backward-compat (LAB-61): members lacking `origin` follow the full
    // 0010 backfill mapping — 'discovery_keep' when the SAME export carries
    // a keep rating for the track, SKIPPED when the track is rated but never
    // kept (legacy eager-join cruft; importing it as a seed would re-anchor
    // refill on a disliked track), else the generic 'seed_track'. Ratings
    // import regardless of membership.
    const kept = {
      isrc: "USABC2222222",
      spotifyId: null,
      title: "Kept legacy member",
      artist: "Artist",
      album: null,
      genres: ["rock"],
    };
    const unrated = {
      isrc: "USABC3333333",
      spotifyId: null,
      title: "Unrated legacy member",
      artist: "Artist",
      album: null,
      genres: ["rock"],
    };
    const disliked = {
      isrc: "USABC4444444",
      spotifyId: null,
      title: "Disliked legacy member",
      artist: "Artist",
      album: null,
      genres: ["rock"],
    };
    const payload = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      buckets: [
        {
          name: "Legacy bucket",
          color: null,
          primaryGenre: "rock",
          isColdStartSeed: false,
          members: [kept, unrated, disliked], // no `origin` on any — pre-LAB-61 shape
        },
      ],
      ratings: [
        { decision: "keep" as const, ratedAt: new Date().toISOString(), track: kept },
        { decision: "dislike" as const, ratedAt: new Date().toISOString(), track: disliked },
      ],
    };
    const result = await importTaste(db, payload);
    expect(result.membersAdded).toBe(2);
    expect(result.ratingsInserted).toBe(2);

    const reMembers = await db
      .select({ isrc: schema.track.isrc, origin: schema.bucketMember.origin })
      .from(schema.bucketMember)
      .innerJoin(schema.track, sql`${schema.track.id} = ${schema.bucketMember.trackId}`);
    expect(reMembers).toHaveLength(2);
    const byIsrc = new Map(reMembers.map((m) => [m.isrc, m.origin]));
    expect(byIsrc.get("USABC2222222")).toBe("discovery_keep");
    expect(byIsrc.get("USABC3333333")).toBe("seed_track");
    expect(byIsrc.has("USABC4444444")).toBe(false);

    // The skipped membership never folds into the bucket's derived state…
    const [legacyBucket] = await db.select().from(schema.bucket);
    expect(legacyBucket?.memberCount).toBe(2);
    // …but the dislike rating itself imports (eval substrate stays complete).
    const reRatings = await db.select().from(schema.rating);
    expect(reRatings.map((r) => r.decision).sort()).toEqual(["dislike", "keep"]);
  });
});
