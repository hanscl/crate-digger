import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { buildEmbedding } from "@/lib/embedding";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import { bumpModelVersion, ensureActiveModelVersion } from "@/lib/ranking/version";
import { runSurfacingBatch } from "@/lib/surfacing/pipeline";
import type { Candidate } from "@/lib/ranking/types";

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
  audioFeatures: schema.AudioFeatures | null;
  genres: string[];
}): Promise<{ id: number; embedding: number[] }> {
  const embedding = buildEmbedding({
    audioFeatures: opts.audioFeatures,
    genres: opts.genres,
  });
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: "Artist",
      audioFeatures: opts.audioFeatures,
      genres: opts.genres,
      embedding,
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return { id: row.id, embedding };
}

async function asCandidate(t: { id: number; embedding: number[] }): Promise<Candidate> {
  return { trackId: t.id, embedding: t.embedding, source: "spotify" };
}

describe("ingestRating — Constraint #3 (ratings tag the surface-time model_version)", () => {
  it("attributes the rating to the surface event's pinned version, not whatever is active later", async () => {
    // The user is shown a track under broad-v1, then a retrain bumps the
    // active broad pointer to v2, then the user finally clicks 'keep'. The
    // rating must record v1 (when the recommendation was made) so evals
    // attribute the decision to the version that surfaced the track.
    const t = await insertTrack({
      title: "Track",
      audioFeatures: audio(),
      genres: ["rock"],
    });
    const cand = await asCandidate(t);

    await runSurfacingBatch(db, {
      candidates: [cand],
      noveltyOverride: 1,
      dailyCapOverride: 1,
    });
    const events = await db.select().from(schema.surfaceEvent);
    const surfacedEvent = events[0]!;
    const surfacingVersionId = surfacedEvent.modelVersionId;

    // Bump the broad version after surfacing — simulates a retrain that
    // landed before the user got around to rating.
    const v2 = await bumpModelVersion(db, "broad", {
      weights: Array.from({ length: 64 }, () => 0.5),
      bias: 0.1,
      trainedSampleCount: 10,
    });
    expect(v2.id).not.toBe(surfacingVersionId);

    const result = await ingestRating(db, {
      trackId: t.id,
      decision: "keep",
      surfaceEventId: surfacedEvent.id,
    });

    expect(result.rating.modelVersionId).toBe(surfacingVersionId);
    // Sanity: the active broad version moved forward but the rating did not.
    const activeBroad = await db
      .select({ active: schema.appConfig.activeBroadVersionId })
      .from(schema.appConfig)
      .limit(1);
    expect(activeBroad[0]?.active).toBe(v2.id);
  });

  it("falls back to the active broad version when no surface_event is provided", async () => {
    // Cold-start path: an import or a manually-rated track that never went
    // through surfacing. The rating still needs a valid version FK; we
    // bootstrap and use the active broad chain.
    const t = await insertTrack({ title: "Cold", audioFeatures: audio(), genres: ["rock"] });
    const result = await ingestRating(db, { trackId: t.id, decision: "keep" });
    const broadActive = await ensureActiveModelVersion(db, "broad");
    expect(result.rating.modelVersionId).toBe(broadActive.id);
    expect(result.rating.surfaceEventId).toBeNull();
  });

  it("rejects ingestion when the supplied surface_event does not exist", async () => {
    const t = await insertTrack({ title: "Orphan", audioFeatures: audio(), genres: ["rock"] });
    await expect(
      ingestRating(db, { trackId: t.id, decision: "keep", surfaceEventId: 99999 }),
    ).rejects.toThrow(/not found/);
    const all = await db.select().from(schema.rating);
    expect(all).toHaveLength(0);
  });
});

describe("ingestRating — bucket dislike counter side effect", () => {
  it("increments bucket.dislikeCount when the rated track is a bucket member and the decision is 'dislike'", async () => {
    const t = await insertTrack({
      title: "Member",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    const assignment = await assignTrack(db, t.id, { spawnThreshold: 0.7 });
    expect(assignment.spawned).toBe(true);

    const result = await ingestRating(db, { trackId: t.id, decision: "dislike" });
    expect(result.bucketDislikeIncremented).toBe(true);

    const [bucketRow] = await db
      .select({ dislikeCount: schema.bucket.dislikeCount })
      .from(schema.bucket)
      .where(sql`${schema.bucket.id} = ${assignment.bucketId}`);
    expect(bucketRow?.dislikeCount).toBe(1);
  });

  it("does not double-increment bucket.dislikeCount when the same track is disliked twice", async () => {
    // dislikeCount feeds the split heuristic as `dislikeCount / memberCount`.
    // A track surfaced twice and disliked both times must only count once —
    // otherwise rate can exceed 1.0 and bucket purity goes negative.
    const t = await insertTrack({
      title: "Repeat-dislike",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    const assignment = await assignTrack(db, t.id, { spawnThreshold: 0.7 });

    const first = await ingestRating(db, { trackId: t.id, decision: "dislike" });
    expect(first.bucketDislikeIncremented).toBe(true);
    const second = await ingestRating(db, { trackId: t.id, decision: "dislike" });
    expect(second.bucketDislikeIncremented).toBe(false);

    const [bucketRow] = await db
      .select({ dislikeCount: schema.bucket.dislikeCount, memberCount: schema.bucket.memberCount })
      .from(schema.bucket)
      .where(sql`${schema.bucket.id} = ${assignment.bucketId}`);
    expect(bucketRow?.dislikeCount).toBe(1);
    // Sanity: the rate stays in [0, 1].
    expect(bucketRow!.dislikeCount).toBeLessThanOrEqual(bucketRow!.memberCount);
  });

  it("does not touch bucket.dislikeCount on 'keep' or for non-member tracks", async () => {
    const member = await insertTrack({
      title: "Member",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    const assignment = await assignTrack(db, member.id, { spawnThreshold: 0.7 });
    await ingestRating(db, { trackId: member.id, decision: "keep" });

    const orphan = await insertTrack({
      title: "Orphan-no-bucket",
      audioFeatures: audio(),
      genres: ["rock"],
    });
    const orphanResult = await ingestRating(db, { trackId: orphan.id, decision: "dislike" });
    expect(orphanResult.bucketDislikeIncremented).toBe(false);

    const [bucketRow] = await db
      .select({ dislikeCount: schema.bucket.dislikeCount })
      .from(schema.bucket)
      .where(sql`${schema.bucket.id} = ${assignment.bucketId}`);
    expect(bucketRow?.dislikeCount).toBe(0);
  });
});
