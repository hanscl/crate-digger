import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import * as schema from "@/db/schema";
import type { AudioFeatures } from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { buildEmbedding } from "@/lib/embedding";

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const PROVISION_TIMEOUT = 120_000;
const SPAWN_THRESHOLD = 0.7;

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
  await migrate(db, {
    migrationsFolder: path.resolve(import.meta.dirname, "../../migrations"),
  });
}, PROVISION_TIMEOUT);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketMember} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucket} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.trackSource} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
});

function audio(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
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
  artist?: string;
  audioFeatures: AudioFeatures | null;
  genres: string[];
}): Promise<number> {
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: opts.artist ?? "Test Artist",
      audioFeatures: opts.audioFeatures,
      genres: opts.genres,
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return row.id;
}

describe("assignTrack — spawn-or-join contract", () => {
  it("joins the existing bucket when within the spawn threshold (same primary genre, near centroid)", async () => {
    // Seed bucket: a single rock track. Then add an essentially identical
    // second rock track — cosine ≈ 1, well above threshold, must join.
    const seedAudio = audio({ tempo: 130, energy: 0.7, valence: 0.6 });
    const seedId = await insertTrack({ title: "Seed", audioFeatures: seedAudio, genres: ["rock"] });
    const seedResult = await assignTrack(db, seedId, { spawnThreshold: SPAWN_THRESHOLD });
    expect(seedResult.spawned).toBe(true);

    const secondId = await insertTrack({
      title: "Near twin",
      audioFeatures: seedAudio,
      genres: ["rock"],
    });
    const joinResult = await assignTrack(db, secondId, { spawnThreshold: SPAWN_THRESHOLD });
    expect(joinResult.spawned).toBe(false);
    expect(joinResult.alreadyAssigned).toBe(false);
    expect(joinResult.bucketId).toBe(seedResult.bucketId);
    expect(joinResult.similarity).toBeGreaterThanOrEqual(SPAWN_THRESHOLD);

    const buckets = await db.select().from(schema.bucket);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.memberCount).toBe(2);
    const members = await db.select().from(schema.bucketMember);
    expect(members).toHaveLength(2);
  });

  it("spawns a new bucket when no candidate is within the spawn threshold", async () => {
    // Same primary genre (rock) but audio so different that cosine drops
    // below threshold. The track must spawn a separate bucket rather than
    // collapse into the seed.
    const seedId = await insertTrack({
      title: "Loud rock",
      audioFeatures: audio({
        tempo: 270,
        energy: 1,
        valence: 1,
        danceability: 1,
        acousticness: 0,
        instrumentalness: 0,
      }),
      genres: ["rock"],
    });
    await assignTrack(db, seedId, { spawnThreshold: SPAWN_THRESHOLD });

    const farId = await insertTrack({
      title: "Quiet rock",
      audioFeatures: audio({
        tempo: 0,
        energy: 0,
        valence: 0,
        danceability: 0,
        acousticness: 1,
        instrumentalness: 1,
      }),
      genres: ["rock"],
    });
    const result = await assignTrack(db, farId, { spawnThreshold: SPAWN_THRESHOLD });

    expect(result.spawned).toBe(true);
    const buckets = await db.select().from(schema.bucket);
    expect(buckets).toHaveLength(2);
    for (const b of buckets) expect(b.memberCount).toBe(1);
  });

  it("spawns a new bucket when primary genre does not match — even if embeddings are close", async () => {
    // A jazz seed with audio identical to a follow-up classical track. If
    // bucketing falls through to centroid similarity blindly the second
    // track joins; the genre filter must keep them apart.
    const sharedAudio = audio({ tempo: 100, energy: 0.4 });

    const jazzId = await insertTrack({
      title: "Blue note",
      audioFeatures: sharedAudio,
      genres: ["jazz"],
    });
    const jazzResult = await assignTrack(db, jazzId, { spawnThreshold: SPAWN_THRESHOLD });
    expect(jazzResult.primaryGenre).toBe("jazz");

    const classicalId = await insertTrack({
      title: "Adagio",
      audioFeatures: sharedAudio,
      genres: ["classical"],
    });
    const classicalResult = await assignTrack(db, classicalId, {
      spawnThreshold: SPAWN_THRESHOLD,
    });
    expect(classicalResult.primaryGenre).toBe("classical");
    expect(classicalResult.spawned).toBe(true);
    expect(classicalResult.bucketId).not.toBe(jazzResult.bucketId);

    const buckets = await db.select().from(schema.bucket);
    expect(buckets).toHaveLength(2);
    const genres = buckets.map((b) => b.primaryGenre).sort();
    expect(genres).toEqual(["classical", "jazz"]);
  });

  it("Welford: bucket centroid after N joins matches the batch mean of the embeddings", async () => {
    // Add four near-identical rock tracks (so cosine stays above threshold
    // and they all land in the same bucket), then verify the persisted
    // centroid equals the JS-side mean of the four embeddings element-wise.
    const samples: AudioFeatures[] = [
      audio({ tempo: 120, energy: 0.5, valence: 0.5, danceability: 0.5 }),
      audio({ tempo: 122, energy: 0.55, valence: 0.5, danceability: 0.5 }),
      audio({ tempo: 124, energy: 0.5, valence: 0.55, danceability: 0.5 }),
      audio({ tempo: 126, energy: 0.5, valence: 0.5, danceability: 0.55 }),
    ];
    const embeddings = samples.map((af) => buildEmbedding({ audioFeatures: af, genres: ["rock"] }));

    let bucketId: number | null = null;
    for (let i = 0; i < samples.length; i++) {
      const id = await insertTrack({
        title: `Track ${i}`,
        audioFeatures: samples[i] ?? null,
        genres: ["rock"],
      });
      const r = await assignTrack(db, id, { spawnThreshold: SPAWN_THRESHOLD });
      bucketId ??= r.bucketId;
      expect(r.bucketId).toBe(bucketId);
    }

    const [b] = await db
      .select()
      .from(schema.bucket)
      .where(sql`${schema.bucket.id} = ${bucketId}`);
    expect(b).toBeDefined();
    expect(b?.memberCount).toBe(4);

    const dim = embeddings[0]!.length;
    const expected: number[] = Array.from({ length: dim }, (_v, i) => {
      let s = 0;
      for (const e of embeddings) s += e[i] ?? 0;
      return s / embeddings.length;
    });

    // pgvector stores `real` (float32) — precision tops out around 6-7 decimals.
    const persisted = b!.centroid;
    expect(persisted).toHaveLength(dim);
    for (let i = 0; i < dim; i++) {
      expect(persisted[i]).toBeCloseTo(expected[i] ?? 0, 6);
    }

    expect(b?.featureStats.count).toBe(4);
    const meanTempo = samples.reduce((s, x) => s + x.tempo, 0) / samples.length;
    expect(b?.featureStats.mean.tempo).toBeCloseTo(meanTempo, 9);
  });

  it("re-running assignTrack on the same track is a no-op (idempotent)", async () => {
    const id = await insertTrack({
      title: "Idempotent",
      audioFeatures: audio(),
      genres: ["rock"],
    });
    const first = await assignTrack(db, id, { spawnThreshold: SPAWN_THRESHOLD });
    const second = await assignTrack(db, id, { spawnThreshold: SPAWN_THRESHOLD });
    expect(second.alreadyAssigned).toBe(true);
    expect(second.bucketId).toBe(first.bucketId);

    const [b] = await db.select().from(schema.bucket);
    expect(b?.memberCount).toBe(1);
    const members = await db.select().from(schema.bucketMember);
    expect(members).toHaveLength(1);
  });
});

describe("assignTrack — concurrency", () => {
  it("two concurrent calls for the same trackId leave exactly one membership row", async () => {
    // Without the unique index on bucket_member.track_id and an in-tx
    // probe, both callers would observe "no membership" and create two
    // separate buckets containing the same track. The unique constraint
    // makes the loser's tx roll back; the retry loop finds the winner's
    // membership and returns alreadyAssigned.
    const id = await insertTrack({
      title: "Concurrent same-track",
      audioFeatures: audio(),
      genres: ["rock"],
    });

    const [a, b] = await Promise.all([
      assignTrack(db, id, { spawnThreshold: SPAWN_THRESHOLD }),
      assignTrack(db, id, { spawnThreshold: SPAWN_THRESHOLD }),
    ]);

    expect(a.bucketId).toBe(b.bucketId);
    const winners = [a, b].filter((r) => !r.alreadyAssigned);
    const losers = [a, b].filter((r) => r.alreadyAssigned);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const buckets = await db.select().from(schema.bucket);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.memberCount).toBe(1);
    const members = await db.select().from(schema.bucketMember);
    expect(members).toHaveLength(1);
  });

  it("two concurrent joins to the same bucket increment memberCount and centroid correctly", async () => {
    // Without the SELECT … FOR UPDATE on the chosen bucket, both txs read
    // memberCount=1, both compute the new centroid against count=1, both
    // commit memberCount=2 — one sample is silently lost. The lock makes
    // them serialize so the second tx Welford-updates against count=2 and
    // ends at 3. Asserts both counts and that the centroid matches the
    // batch mean of all three embeddings.
    const seedAudio = audio({ tempo: 120, energy: 0.5 });
    const seedId = await insertTrack({
      title: "Seed",
      audioFeatures: seedAudio,
      genres: ["rock"],
    });
    await assignTrack(db, seedId, { spawnThreshold: SPAWN_THRESHOLD });

    const audioA = audio({ tempo: 122, energy: 0.55 });
    const audioB = audio({ tempo: 124, energy: 0.5, valence: 0.55 });
    const idA = await insertTrack({ title: "A", audioFeatures: audioA, genres: ["rock"] });
    const idB = await insertTrack({ title: "B", audioFeatures: audioB, genres: ["rock"] });

    const [resA, resB] = await Promise.all([
      assignTrack(db, idA, { spawnThreshold: SPAWN_THRESHOLD }),
      assignTrack(db, idB, { spawnThreshold: SPAWN_THRESHOLD }),
    ]);
    expect(resA.bucketId).toBe(resB.bucketId);
    expect(resA.alreadyAssigned).toBe(false);
    expect(resB.alreadyAssigned).toBe(false);

    const [theBucket] = await db.select().from(schema.bucket);
    expect(theBucket?.memberCount).toBe(3);
    expect(theBucket?.featureStats.count).toBe(3);

    const expectedTempo = (seedAudio.tempo + audioA.tempo + audioB.tempo) / 3;
    expect(theBucket?.featureStats.mean.tempo).toBeCloseTo(expectedTempo, 6);

    const embeddings = [seedAudio, audioA, audioB].map((af) =>
      buildEmbedding({ audioFeatures: af, genres: ["rock"] }),
    );
    const dim = embeddings[0]!.length;
    const expectedCentroid: number[] = Array.from({ length: dim }, (_v, i) => {
      let s = 0;
      for (const e of embeddings) s += e[i] ?? 0;
      return s / embeddings.length;
    });
    const persisted = theBucket!.centroid;
    for (let i = 0; i < dim; i++) {
      expect(persisted[i]).toBeCloseTo(expectedCentroid[i] ?? 0, 6);
    }
  });
});
