import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { evaluateBucketRecommendations } from "@/lib/bucketing/recommendations";

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

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketRecommendation} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketMember} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucket} RESTART IDENTITY CASCADE`);
});

function emptyStats(): schema.FeatureStats {
  return {
    count: 0,
    mean: {
      tempo: 0,
      energy: 0,
      valence: 0,
      danceability: 0,
      acousticness: 0,
      instrumentalness: 0,
    },
    m2: {
      tempo: 0,
      energy: 0,
      valence: 0,
      danceability: 0,
      acousticness: 0,
      instrumentalness: 0,
    },
  };
}

async function seedBucket(opts: {
  name: string;
  centroid: number[];
  primaryGenre: string | null;
  memberCount?: number;
  dislikeCount?: number;
}): Promise<number> {
  const [row] = await db
    .insert(schema.bucket)
    .values({
      name: opts.name,
      centroid: opts.centroid,
      featureStats: emptyStats(),
      memberCount: opts.memberCount ?? 1,
      dislikeCount: opts.dislikeCount ?? 0,
      primaryGenre: opts.primaryGenre,
    })
    .returning({ id: schema.bucket.id });
  if (!row) throw new Error("bucket insert returned no rows");
  return row.id;
}

const ZERO64 = Array.from({ length: 64 }, () => 0);
function vec(setIdx: number, audioBoost = 0): number[] {
  const v = [...ZERO64];
  // Audio dims [0..5] — give them all the same boost so two near-identical
  // centroids score very high cosine similarity.
  for (let i = 0; i < 6; i++) v[i] = 0.5 + audioBoost;
  // Genre dim at slot 6 + setIdx.
  v[6 + setIdx] = 1;
  return v;
}

describe("evaluateBucketRecommendations — merge heuristic", () => {
  it("emits a merge for two same-genre buckets whose centroids exceed the threshold", async () => {
    const a = await seedBucket({
      name: "rock-a",
      centroid: vec(0),
      primaryGenre: "rock",
    });
    const b = await seedBucket({
      name: "rock-b",
      centroid: vec(0, 0.001),
      primaryGenre: "rock",
    });
    const r = await evaluateBucketRecommendations(db, { mergeThreshold: 0.99 });
    expect(r.merges).toHaveLength(1);
    expect(r.merges[0]?.bucketIds.sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
    expect(r.merges[0]?.kind).toBe("merge");
    expect(r.merges[0]?.status).toBe("pending");
  });

  it("does NOT merge two POPULATED lanes of different primary_genre, even with overlapping slots at high cosine", async () => {
    // LAB-81 — lane×lane keeps the exact-genre gate. Same genre slot (slot 0)
    // and near-identical centroids (cosine ≈ 1), but different primary_genre
    // shelves → no merge. Collapsing two established shelves must never ride on
    // similarity alone.
    await seedBucket({ name: "rock", centroid: vec(0), primaryGenre: "rock", memberCount: 3 });
    await seedBucket({ name: "pop", centroid: vec(0, 0.001), primaryGenre: "pop", memberCount: 3 });
    const r = await evaluateBucketRecommendations(db, { mergeThreshold: 0.5 });
    expect(r.merges).toHaveLength(0);
  });

  it("folds a SINGLETON into a populated neighbor across genre via slot overlap", async () => {
    // LAB-81 — a one-member cold-start seed (disco) shares genre slot 0 with a
    // populated rock shelf. The singleton-fold path uses the slot-overlap gate,
    // so the cross-genre merge IS recommended (JOIN-shaped, not a shelf
    // collapse). accept() folds the singleton into the larger bucket.
    const single = await seedBucket({
      name: "disco (auto)",
      centroid: vec(0),
      primaryGenre: "disco",
      memberCount: 1,
    });
    const lane = await seedBucket({
      name: "Heartfelt Rockers",
      centroid: vec(0, 0.001),
      primaryGenre: "rock",
      memberCount: 20,
    });
    const r = await evaluateBucketRecommendations(db, { mergeThreshold: 0.9 });
    expect(r.merges).toHaveLength(1);
    expect(r.merges[0]?.bucketIds.slice().sort((x, y) => x - y)).toEqual(
      [single, lane].sort((x, y) => x - y),
    );
  });

  it("does NOT fold a singleton into a neighbor it shares no genre slot with", async () => {
    // Different slots (0 vs 1) → no slot overlap → no fold, even though the
    // audio-driven cosine (~0.6) clears the threshold.
    await seedBucket({
      name: "disco (auto)",
      centroid: vec(0),
      primaryGenre: "disco",
      memberCount: 1,
    });
    await seedBucket({
      name: "Heavy Metal Thunder",
      centroid: vec(1),
      primaryGenre: "metal",
      memberCount: 20,
    });
    const r = await evaluateBucketRecommendations(db, { mergeThreshold: 0.5 });
    expect(r.merges).toHaveLength(0);
  });

  it("folds two cross-genre SINGLETONS that share a slot — the case the old exact-genre gate blocked", async () => {
    // Both are 1-member cold-start seeds with DIFFERENT primary_genre but the
    // same genre slot (slot 0). The old `a.primaryGenre !== b.primaryGenre`
    // guard blocked this; the singleton path (either side memberCount === 1)
    // now folds them via slot overlap.
    const a = await seedBucket({
      name: "disco (auto)",
      centroid: vec(0),
      primaryGenre: "disco",
      memberCount: 1,
    });
    const b = await seedBucket({
      name: "funk (auto)",
      centroid: vec(0, 0.001),
      primaryGenre: "funk",
      memberCount: 1,
    });
    const r = await evaluateBucketRecommendations(db, { mergeThreshold: 0.9 });
    expect(r.merges).toHaveLength(1);
    expect(r.merges[0]?.bucketIds.slice().sort((x, y) => x - y)).toEqual(
      [a, b].sort((x, y) => x - y),
    );
  });

  it("is idempotent — running twice does not create duplicates", async () => {
    await seedBucket({ name: "a", centroid: vec(0), primaryGenre: "rock" });
    await seedBucket({ name: "b", centroid: vec(0, 0.001), primaryGenre: "rock" });
    const first = await evaluateBucketRecommendations(db, { mergeThreshold: 0.99 });
    const second = await evaluateBucketRecommendations(db, { mergeThreshold: 0.99 });
    expect(first.merges).toHaveLength(1);
    expect(first.totalPending).toBe(1);
    // Second call sees the existing pending row and returns nothing new, but
    // totalPending still reflects the pre-existing row.
    expect(second.merges).toHaveLength(0);
    expect(second.totalPending).toBe(1);
    const all = await db.select().from(schema.bucketRecommendation);
    expect(all).toHaveLength(1);
  });
});

describe("evaluateBucketRecommendations — split heuristic", () => {
  it("emits a split for a bucket whose dislike rate ≥ threshold and member count ≥ 4", async () => {
    const id = await seedBucket({
      name: "noisy-bucket",
      centroid: vec(0),
      primaryGenre: "rock",
      memberCount: 6,
      dislikeCount: 4, // 4/6 ≈ 0.67 ≥ 0.5
    });
    const r = await evaluateBucketRecommendations(db, { splitDislikeRate: 0.5 });
    expect(r.splits).toHaveLength(1);
    expect(r.splits[0]?.bucketIds).toEqual([id]);
    expect(r.splits[0]?.kind).toBe("split");
    const reason = r.splits[0]?.reason as { dislikeRate: number };
    expect(reason.dislikeRate).toBeCloseTo(4 / 6, 5);
  });

  it("does not split tiny buckets even at high dislike rate (single dislike fluctuation)", async () => {
    // A bucket with 3 members and 2 dislikes has rate 0.67 but is below
    // the 4-member floor — wait until there's a real signal.
    await seedBucket({
      name: "tiny",
      centroid: vec(0),
      primaryGenre: "rock",
      memberCount: 3,
      dislikeCount: 2,
    });
    const r = await evaluateBucketRecommendations(db, { splitDislikeRate: 0.5 });
    expect(r.splits).toHaveLength(0);
  });

  it("split idempotency: the same bucket does not yield duplicate recommendations on a second run", async () => {
    await seedBucket({
      name: "noisy",
      centroid: vec(0),
      primaryGenre: "rock",
      memberCount: 6,
      dislikeCount: 4,
    });
    const first = await evaluateBucketRecommendations(db, { splitDislikeRate: 0.5 });
    const second = await evaluateBucketRecommendations(db, { splitDislikeRate: 0.5 });
    expect(first.splits).toHaveLength(1);
    expect(second.splits).toHaveLength(0);
    const all = await db.select().from(schema.bucketRecommendation);
    expect(all).toHaveLength(1);
  });
});
