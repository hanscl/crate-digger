import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { buildEmbedding } from "@/lib/embedding";
import { counterfactualReplay } from "@/lib/evals/counterfactual";
import { bumpModelVersion, getActiveModelVersion } from "@/lib/ranking/version";
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
  audio: schema.AudioFeatures;
  genres: string[];
}): Promise<{ id: number; embedding: number[] }> {
  const embedding = buildEmbedding({
    audioFeatures: opts.audio,
    genres: opts.genres,
  });
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: "x",
      audioFeatures: opts.audio,
      genres: opts.genres,
      embedding,
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return { id: row.id, embedding };
}

async function asCand(t: { id: number; embedding: number[] }): Promise<Candidate> {
  return { trackId: t.id, embedding: t.embedding, source: "spotify" };
}

describe("counterfactualReplay — broad", () => {
  it("agrees on the surfaced winner when replayed against the same version", async () => {
    // Sanity: replay against the version an event was logged under should
    // pick the same top-1 winner as the surfacing pipeline did. We use cap=1
    // so the surfacing pipeline's top-1 selection lines up exactly with
    // replay's top-1 selection — at higher caps the pipeline surfaces top-K
    // while replay surfaces top-1, which is an inherent rank-vs-pick
    // mismatch the Analyzer screen models separately.
    const tracks = [];
    for (let i = 0; i < 4; i++) {
      tracks.push(
        await seed({
          title: `T${i}`,
          audio: audio({ valence: 0.1 + i * 0.2 }),
          genres: ["rock"],
        }),
      );
    }
    const candidates = await Promise.all(tracks.map(asCand));
    await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      dailyCapOverride: 1,
    });

    const active = await getActiveModelVersion(db, "broad");
    if (!active) throw new Error("expected active broad version");

    const replay = await counterfactualReplay(db, active.id);
    expect(replay.targetKind).toBe("broad");
    expect(replay.replayedEventCount).toBe(1);
    expect(replay.agreementCount).toBe(1);
    expect(replay.agreementRate).toBe(1);
    const evt = replay.perEvent[0]!;
    expect(evt.agreed).toBe(true);
    expect(evt.replayedTrackId).toBe(evt.originalTrackId);
    // Pool entries survive the round-trip and stay sorted highest-first.
    expect(evt.replayedPool).toHaveLength(4);
    for (let i = 1; i < evt.replayedPool.length; i++) {
      expect(evt.replayedPool[i - 1]!.score).toBeGreaterThanOrEqual(evt.replayedPool[i]!.score);
    }
  });

  it("a different version's weights produce a different winner — agreementRate < 1", async () => {
    // Surface under bootstrap (untrained) prior=0.5 → tie-break by trackId
    // → first track wins. Then bump to a version whose weights skew toward
    // the LAST track's embedding shape; replay should now pick the last
    // track. Agreement rate strictly less than 1 proves the replay actually
    // re-runs the ranker rather than echoing the persisted winner.
    const tracks = [];
    for (let i = 0; i < 3; i++) {
      tracks.push(
        await seed({
          title: `T${i}`,
          audio: audio({ valence: 0.1 + i * 0.4 }),
          genres: ["rock"],
        }),
      );
    }
    const candidates = await Promise.all(tracks.map(asCand));
    await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      dailyCapOverride: 1,
    });

    // Build weights that put strong positive coefficients on the high-valence
    // dimension (idx 2 in the embedding's audio segment). Track #2 has
    // valence=0.9 → highest score under these weights.
    const weights = Array.from({ length: 64 }, () => 0);
    weights[2] = 50;
    const newVersion = await bumpModelVersion(db, "broad", {
      weights,
      bias: 0,
      trainedSampleCount: 100,
    });

    const replay = await counterfactualReplay(db, newVersion.id);
    expect(replay.replayedEventCount).toBe(1);
    const evt = replay.perEvent[0]!;
    // The original surfaced track (under untrained tie-break) is not the
    // valence-weighted winner.
    const expectedReplayWinner = tracks[2]!.id;
    expect(evt.replayedTrackId).toBe(expectedReplayWinner);
    expect(evt.agreed).toBe(evt.originalTrackId === expectedReplayWinner);
    expect(replay.agreementRate).toBeLessThan(1);
  });

  it("skips surface events whose ranker_kind doesn't match the target version", async () => {
    // Replay a broad version against a refill-only event corpus → all events
    // are kindMismatched and replayedEventCount = 0. (We force a single
    // refill event by seeding a bucket and surfacing pure refill.)
    const t1 = await seed({ title: "anchor", audio: audio(), genres: ["rock"] });
    const c1 = await asCand(t1);
    // Drive an initial assignment by surfacing in pure-broad first to seed
    // a bucket. Simpler: insert a bucket + member by hand.
    const [bucketRow] = await db
      .insert(schema.bucket)
      .values({
        name: "rock",
        centroid: t1.embedding,
        featureStats: {
          count: 1,
          mean: audio(),
          m2: {
            tempo: 0,
            energy: 0,
            valence: 0,
            danceability: 0,
            acousticness: 0,
            instrumentalness: 0,
          },
        },
        memberCount: 1,
        primaryGenre: "rock",
      })
      .returning({ id: schema.bucket.id });
    await db.insert(schema.bucketMember).values({
      bucketId: bucketRow!.id,
      trackId: t1.id,
      similarityAtJoin: 1,
    });
    const t2 = await seed({
      title: "candidate",
      audio: audio({ tempo: 121 }),
      genres: ["rock"],
    });
    const c2 = await asCand(t2);
    await runSurfacingBatch(db, {
      candidates: [c1, c2],
      noveltyOverride: 0, // pure refill
      dailyCapOverride: 1,
    });

    const broadActive = await getActiveModelVersion(db, "broad");
    if (!broadActive) throw new Error("expected broad active");
    const replay = await counterfactualReplay(db, broadActive.id);
    expect(replay.targetKind).toBe("broad");
    // The refill event is scanned but classified as kind-mismatched (not
    // SQL-prefiltered) so callers can see how much of the window was outside
    // the target's kind.
    expect(replay.scannedEventCount).toBe(1);
    expect(replay.replayedEventCount).toBe(0);
    expect(replay.kindMismatchedEventIds).toHaveLength(1);
  });
});
