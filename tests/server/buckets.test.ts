import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { buildEmbedding } from "@/lib/embedding";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import type { Env } from "@/server/env";
import { bucketsRouter } from "@/server/routers/buckets";
import { createCallerFactory } from "@/server/trpc-base";

/**
 * Buckets router — LAB-62 `removeMember` coverage: membership is deleted and
 * derived bucket state recomputed; track + rating rows survive (membership
 * and rating are independent dimensions); the last removal prunes the
 * bucket; stale pending recommendations referencing the bucket are pruned.
 */

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const PROVISION_TIMEOUT = 120_000;

const createCaller = createCallerFactory(bucketsRouter);
const caller = () =>
  createCaller({
    db,
    appEnv: {} as Env,
    isAuthenticated: true,
  });

/** Full assign-config override set — skips the per-call config DB reads. */
const ASSIGN_OPTS = {
  origin: "seed_track",
  spawnThreshold: 0.7,
  audioWeight: 1,
  genreGate: "slot-overlap",
} as const;

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
  await db.execute(sql`TRUNCATE TABLE ${schema.rating} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.surfaceEvent} RESTART IDENTITY CASCADE`);
  await db.execute(
    sql`UPDATE ${schema.appConfig} SET active_refill_version_id = NULL, active_broad_version_id = NULL`,
  );
  await db.execute(sql`TRUNCATE TABLE ${schema.modelVersion} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketRecommendation} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketMember} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucket} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
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

async function insertTrack(title: string): Promise<number> {
  const audioFeatures = audio();
  const genres = ["rock"];
  const [row] = await db
    .insert(schema.track)
    .values({
      title,
      artist: "Artist",
      audioFeatures,
      genres,
      primaryGenre: "rock",
      embedding: buildEmbedding({ audioFeatures, genres }),
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return row.id;
}

/** Spawn a bucket from one track and join the rest (identical embeddings → sim 1.0). */
async function seedBucket(titles: string[]): Promise<{ bucketId: number; trackIds: number[] }> {
  let bucketId: number | null = null;
  const trackIds: number[] = [];
  for (const title of titles) {
    const id = await insertTrack(title);
    const result = await assignTrack(db, id, ASSIGN_OPTS);
    bucketId ??= result.bucketId;
    expect(result.bucketId).toBe(bucketId);
    trackIds.push(id);
  }
  if (bucketId === null) throw new Error("no bucket spawned");
  return { bucketId, trackIds };
}

describe("buckets.removeMember (LAB-62)", () => {
  it("deletes the membership and recomputes member_count; track and rating rows survive", async () => {
    const { bucketId, trackIds } = await seedBucket(["A", "B"]);
    const [removed, kept] = trackIds as [number, number];
    // A defer rating on the removed track must survive the removal.
    await ingestRating(db, { trackId: removed, decision: "defer" });

    const out = await caller().removeMember({ bucketId, trackId: removed });
    expect(out).toEqual({ ok: true, bucketPruned: false });

    const members = await db
      .select({ trackId: schema.bucketMember.trackId })
      .from(schema.bucketMember)
      .where(eq(schema.bucketMember.bucketId, bucketId));
    expect(members.map((m) => m.trackId)).toEqual([kept]);

    const [b] = await db.select().from(schema.bucket).where(eq(schema.bucket.id, bucketId));
    expect(b?.memberCount).toBe(1);

    const [track] = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(eq(schema.track.id, removed));
    expect(track).toBeDefined();
    const ratings = await db
      .select({ id: schema.rating.id })
      .from(schema.rating)
      .where(eq(schema.rating.trackId, removed));
    expect(ratings).toHaveLength(1);
  });

  it("prunes the bucket when the last member is removed", async () => {
    const { bucketId, trackIds } = await seedBucket(["Solo"]);

    const out = await caller().removeMember({ bucketId, trackId: trackIds[0]! });
    expect(out).toEqual({ ok: true, bucketPruned: true });

    const buckets = await db
      .select({ id: schema.bucket.id })
      .from(schema.bucket)
      .where(eq(schema.bucket.id, bucketId));
    expect(buckets).toHaveLength(0);
  });

  it("prunes pending recommendations referencing the bucket; unrelated ones survive", async () => {
    const { bucketId, trackIds } = await seedBucket(["A", "B"]);
    await db.insert(schema.bucketRecommendation).values([
      { kind: "merge", bucketIds: [bucketId, 999], reason: {} },
      { kind: "merge", bucketIds: [997, 998], reason: {} },
      { kind: "split", bucketIds: [bucketId], reason: {}, status: "dismissed" },
    ]);

    await caller().removeMember({ bucketId, trackId: trackIds[0]! });

    const recs = await db
      .select({
        bucketIds: schema.bucketRecommendation.bucketIds,
        status: schema.bucketRecommendation.status,
      })
      .from(schema.bucketRecommendation);
    // The pending rec referencing this bucket is gone; the unrelated pending
    // rec and the already-resolved (dismissed) rec keep their audit trail.
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.bucketIds.includes(997))?.status).toBe("pending");
    expect(recs.find((r) => r.bucketIds.includes(bucketId))?.status).toBe("dismissed");
  });

  it("NOT_FOUND for a track that is not a member", async () => {
    const { bucketId } = await seedBucket(["A"]);
    const stranger = await insertTrack("Not a member");
    await expect(caller().removeMember({ bucketId, trackId: stranger })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

function emptyStats(): schema.FeatureStats {
  const zero = {
    tempo: 0,
    energy: 0,
    valence: 0,
    danceability: 0,
    acousticness: 0,
    instrumentalness: 0,
  };
  return { count: 0, mean: { ...zero }, m2: { ...zero } };
}

describe("buckets.accept — merge (LAB-81 keep-larger)", () => {
  it("folds the singleton into the larger bucket, keeping the larger bucket's identity", async () => {
    const centroid = buildEmbedding({ audioFeatures: audio(), genres: ["rock"] });

    // Member tracks (bucket_member FK targets).
    const t1 = await insertTrack("singleton-track");
    const t2 = await insertTrack("lane-track-1");
    const t3 = await insertTrack("lane-track-2");

    // Singleton created FIRST → lower id, so keep-larger must beat keep-min-id.
    const [single] = await db
      .insert(schema.bucket)
      .values({
        name: "disco (auto)",
        centroid,
        featureStats: emptyStats(),
        memberCount: 1,
        primaryGenre: "disco",
      })
      .returning({ id: schema.bucket.id });
    const [lane] = await db
      .insert(schema.bucket)
      .values({
        name: "Heartfelt Rockers",
        centroid,
        featureStats: emptyStats(),
        memberCount: 2,
        primaryGenre: "rock",
      })
      .returning({ id: schema.bucket.id });
    if (!single || !lane) throw new Error("bucket insert returned no rows");

    await db.insert(schema.bucketMember).values([
      { bucketId: single.id, trackId: t1, origin: "seed_track" },
      { bucketId: lane.id, trackId: t2, origin: "seed_track" },
      { bucketId: lane.id, trackId: t3, origin: "seed_track" },
    ]);

    const [rec] = await db
      .insert(schema.bucketRecommendation)
      .values({
        kind: "merge",
        bucketIds: [single.id, lane.id].sort((a, b) => a - b),
        reason: { similarity: 0.95, threshold: 0.81 },
      })
      .returning({ id: schema.bucketRecommendation.id });
    if (!rec) throw new Error("recommendation insert returned no rows");

    const out = await caller().accept({ recommendationId: rec.id });
    expect(out).toMatchObject({ ok: true, kind: "merge" });

    // The singleton (lower id) is gone; the larger lane bucket survives with
    // all three members and keeps its name.
    const survivors = await db.select().from(schema.bucket);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(lane.id);
    expect(survivors[0]?.name).toBe("Heartfelt Rockers");
    expect(survivors[0]?.memberCount).toBe(3);

    const members = await db.select().from(schema.bucketMember);
    expect(members).toHaveLength(3);
    expect(members.every((m) => m.bucketId === lane.id)).toBe(true);
  });
});
