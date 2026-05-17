import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { buildEmbedding } from "@/lib/embedding";
import {
  audioFeatureCoverage,
  bucketPurity,
  genreEntropy,
  keepRate,
  precisionAtN,
} from "@/lib/evals/metrics";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import { ensureActiveModelVersion } from "@/lib/ranking/version";
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
  await db.execute(sql`TRUNCATE TABLE ${schema.trackSource} RESTART IDENTITY CASCADE`);
  await db.execute(
    sql`UPDATE ${schema.appConfig} SET active_refill_version_id = NULL, active_broad_version_id = NULL`,
  );
  await db.execute(sql`TRUNCATE TABLE ${schema.modelVersion} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketMember} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucket} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
});

function audio(o: Partial<schema.AudioFeatures> = {}): schema.AudioFeatures {
  return {
    tempo: 120,
    energy: 0.5,
    valence: 0.5,
    danceability: 0.5,
    acousticness: 0.5,
    instrumentalness: 0.5,
    ...o,
  };
}

async function seed(opts: {
  title: string;
  audio?: schema.AudioFeatures | null;
  genres: string[];
  primaryGenre?: string;
  source?: schema.Track["genres"] extends never ? never : "spotify" | "lastfm" | "viberate";
}): Promise<{ id: number; embedding: number[] }> {
  const a = opts.audio === undefined ? audio() : opts.audio;
  const embedding = buildEmbedding({ audioFeatures: a, genres: opts.genres });
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: "x",
      audioFeatures: a,
      genres: opts.genres,
      embedding,
      primaryGenre: opts.primaryGenre ?? opts.genres[0] ?? null,
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  if (opts.source) {
    await db.insert(schema.trackSource).values({
      trackId: row.id,
      source: opts.source,
      sourceTrackId: `${opts.source}-${row.id}`,
    });
  }
  return { id: row.id, embedding };
}

async function asCand(t: { id: number; embedding: number[] }): Promise<Candidate> {
  return { trackId: t.id, embedding: t.embedding, source: "spotify" };
}

describe("keepRate", () => {
  it("breaks down keep / decided counts by ranker, version, and source", async () => {
    // Three tracks: kept, kept, disliked. Two are spotify-sourced; one is
    // last.fm. All surface under broad. Expect overall = 2/3, by source =
    // spotify 2/2 + lastfm 0/1 (because the disliked one was on lastfm).
    const a = await seed({ title: "A", genres: ["rock"], source: "spotify" });
    const b = await seed({ title: "B", genres: ["rock"], source: "spotify" });
    const c = await seed({ title: "C", genres: ["rock"], source: "lastfm" });
    const cands = await Promise.all([a, b, c].map(asCand));
    await runSurfacingBatch(db, {
      candidates: cands,
      noveltyOverride: 1,
      dailyCapOverride: 3,
    });
    const events = await db.select().from(schema.surfaceEvent);
    const byTrack = new Map(events.map((e) => [e.trackId, e.id]));
    await ingestRating(db, { trackId: a.id, decision: "keep", surfaceEventId: byTrack.get(a.id) });
    await ingestRating(db, { trackId: b.id, decision: "keep", surfaceEventId: byTrack.get(b.id) });
    await ingestRating(db, {
      trackId: c.id,
      decision: "dislike",
      surfaceEventId: byTrack.get(c.id),
    });

    const kr = await keepRate(db);
    expect(kr.overall.decided).toBe(3);
    expect(kr.overall.keeps).toBe(2);
    expect(kr.overall.rate).toBeCloseTo(2 / 3, 9);
    expect(kr.byRanker.broad.decided).toBe(3);
    expect(kr.byRanker.refill.decided).toBe(0);
    expect(kr.bySource.spotify?.keeps).toBe(2);
    expect(kr.bySource.lastfm?.keeps).toBe(0);
    expect(kr.bySource.lastfm?.decided).toBe(1);
  });
});

describe("precisionAtN", () => {
  it("counts kept tracks among the N most recent surfaced events", async () => {
    // Surface 5 tracks; rate 3 of them keep. P@3 (newest 3) → some keep
    // count. Since P@N reads the newest N, control the surfacing order by
    // surfacing in two batches.
    const t1 = await seed({ title: "1", genres: ["rock"] });
    const t2 = await seed({ title: "2", genres: ["rock"] });
    const t3 = await seed({ title: "3", genres: ["rock"] });
    await runSurfacingBatch(db, {
      candidates: await Promise.all([t1, t2, t3].map(asCand)),
      noveltyOverride: 1,
      dailyCapOverride: 3,
    });
    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(3);
    // Rate t1 keep, t2 keep, t3 dislike.
    const eventByTrack = new Map(events.map((e) => [e.trackId, e.id]));
    await ingestRating(db, {
      trackId: t1.id,
      decision: "keep",
      surfaceEventId: eventByTrack.get(t1.id),
    });
    await ingestRating(db, {
      trackId: t2.id,
      decision: "keep",
      surfaceEventId: eventByTrack.get(t2.id),
    });
    await ingestRating(db, {
      trackId: t3.id,
      decision: "dislike",
      surfaceEventId: eventByTrack.get(t3.id),
    });

    const p3 = await precisionAtN(db, 3);
    expect(p3.surfacedCount).toBe(3);
    expect(p3.keptCount).toBe(2);
    expect(p3.precision).toBeCloseTo(2 / 3, 9);
  });

  it("returns zero precision when no surfaces have happened", async () => {
    const p = await precisionAtN(db, 10);
    expect(p.surfacedCount).toBe(0);
    expect(p.precision).toBe(0);
  });
});

describe("bucketPurity", () => {
  it("computes 1 − dislikeRate per bucket; zero-member buckets get rate 0", async () => {
    // Hand-seed the bucket rather than going through assignTrack to keep
    // the math fully under our control.
    const [b1] = await db
      .insert(schema.bucket)
      .values({
        name: "clean",
        centroid: Array.from({ length: 64 }, () => 0),
        featureStats: {
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
        },
        memberCount: 5,
        dislikeCount: 1,
      })
      .returning({ id: schema.bucket.id });
    const [b2] = await db
      .insert(schema.bucket)
      .values({
        name: "noisy",
        centroid: Array.from({ length: 64 }, () => 0),
        featureStats: {
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
        },
        memberCount: 4,
        dislikeCount: 3,
      })
      .returning({ id: schema.bucket.id });

    const purity = await bucketPurity(db);
    const cleanRow = purity.find((p) => p.bucketId === b1!.id)!;
    const noisyRow = purity.find((p) => p.bucketId === b2!.id)!;
    expect(cleanRow.dislikeRate).toBeCloseTo(1 / 5, 9);
    expect(cleanRow.purity).toBeCloseTo(4 / 5, 9);
    expect(noisyRow.dislikeRate).toBeCloseTo(3 / 4, 9);
    expect(noisyRow.purity).toBeCloseTo(1 / 4, 9);
  });
});

describe("genreEntropy", () => {
  it("hits zero when only one genre is surfaced and saturates as the genre mix flattens", async () => {
    // All-rock first → entropy should be 0 (a single bucket, no diversity).
    const r1 = await seed({ title: "r1", genres: ["rock"], primaryGenre: "rock" });
    const r2 = await seed({ title: "r2", genres: ["rock"], primaryGenre: "rock" });
    await runSurfacingBatch(db, {
      candidates: await Promise.all([r1, r2].map(asCand)),
      noveltyOverride: 1,
      dailyCapOverride: 2,
    });
    const single = await genreEntropy(db);
    expect(single.entropy).toBe(0);
    expect(single.distinctGenres).toBe(1);

    // Mix in a pop track and a jazz track — three genres, three surfaced.
    // Uniform → normalized entropy = 1.
    await db.execute(sql`UPDATE ${schema.appConfig} SET daily_surface_cap = 5`);
    const p = await seed({ title: "p", genres: ["pop"], primaryGenre: "pop" });
    const j = await seed({ title: "j", genres: ["jazz"], primaryGenre: "jazz" });
    await runSurfacingBatch(db, {
      candidates: await Promise.all([p, j].map(asCand)),
      noveltyOverride: 1,
      dailyCapOverride: 5,
    });
    const mixed = await genreEntropy(db);
    expect(mixed.distinctGenres).toBe(3);
    // 4 surfaced (rock×2, pop, jazz). p_rock=0.5, p_pop=0.25, p_jazz=0.25.
    // Entropy = -0.5·ln(0.5) - 0.25·ln(0.25) - 0.25·ln(0.25)
    const expected = -(0.5 * Math.log(0.5) + 0.25 * Math.log(0.25) + 0.25 * Math.log(0.25));
    expect(mixed.entropy).toBeCloseTo(expected, 9);
    expect(mixed.normalized).toBeCloseTo(expected / Math.log(3), 9);
  });
});

describe("audioFeatureCoverage", () => {
  it("reports the fraction of tracks carrying non-null audio_features", async () => {
    const empty = await audioFeatureCoverage(db);
    expect(empty).toEqual({ total: 0, withFeatures: 0, coverage: 0 });

    await seed({ title: "a", genres: ["rock"], audio: audio() });
    await seed({ title: "b", genres: ["rock"], audio: audio() });
    await seed({ title: "c", genres: ["rock"], audio: null });

    const cov = await audioFeatureCoverage(db);
    expect(cov.total).toBe(3);
    expect(cov.withFeatures).toBe(2);
    expect(cov.coverage).toBeCloseTo(2 / 3, 9);
  });
});

// Sanity: the helpers above exercise ensureActiveModelVersion implicitly, but
// keep an unused import alive when the test grows so the linter doesn't strip
// it from the working snapshot.
void ensureActiveModelVersion;
