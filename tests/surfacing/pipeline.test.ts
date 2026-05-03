import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { AudioFeatures, CandidatePoolEntry } from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { buildEmbedding } from "@/lib/embedding";
import { scoreBroad } from "@/lib/ranking/broad";
import { scoreRefill } from "@/lib/ranking/refill";
import type { BroadConfig, Candidate } from "@/lib/ranking/types";
import {
  bumpModelVersion,
  ensureActiveModelVersion,
  getActiveConfig,
  getActiveModelVersion,
} from "@/lib/ranking/version";
import { runSurfacingBatch } from "@/lib/surfacing/pipeline";

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
  await migrate(db, {
    migrationsFolder: path.resolve(import.meta.dirname, "../../migrations"),
  });
}, PROVISION_TIMEOUT);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

beforeEach(async () => {
  // Order matters — surface_event references model_version, so wipe it first.
  await db.execute(sql`TRUNCATE TABLE ${schema.rating} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.surfaceEvent} RESTART IDENTITY CASCADE`);
  await db.execute(
    sql`UPDATE ${schema.appConfig} SET active_refill_version_id = NULL, active_broad_version_id = NULL`,
  );
  await db.execute(sql`TRUNCATE TABLE ${schema.modelVersion} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketMember} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucket} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.trackSource} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
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
  audioFeatures: AudioFeatures | null;
  genres: string[];
}): Promise<{ id: number; embedding: number[]; audio: AudioFeatures | null }> {
  const embedding = buildEmbedding({
    audioFeatures: opts.audioFeatures,
    genres: opts.genres,
  });
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: "Test Artist",
      audioFeatures: opts.audioFeatures,
      genres: opts.genres,
      embedding,
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return { id: row.id, embedding, audio: opts.audioFeatures };
}

async function asCandidate(t: {
  id: number;
  embedding: number[];
  audio: AudioFeatures | null;
}): Promise<Candidate> {
  return {
    trackId: t.id,
    embedding: t.embedding,
    audioFeatures: t.audio,
    source: "spotify",
  };
}

describe("runSurfacingBatch — Constraint #2 (full candidate pool persistence)", () => {
  it("every surface_event records every candidate's score, not just the winner", async () => {
    // 5 candidates, daily cap = 2 → expect 2 surface_events. Each event's
    // candidate_pool MUST include all 5 entries with their scores. Losing
    // this property breaks every downstream eval silently.
    const tracks = [];
    for (let i = 0; i < 5; i++) {
      const t = await insertTrack({
        title: `T${i}`,
        audioFeatures: audio({ energy: 0.1 + i * 0.15 }),
        genres: ["rock"],
      });
      tracks.push(t);
    }
    const candidates = await Promise.all(tracks.map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1, // pure broad, deterministic
      dailyCapOverride: 2,
      queueCeilingOverride: 50,
    });

    expect(result.events).toHaveLength(2);
    expect(result.refillQuota).toBe(0);
    expect(result.broadQuota).toBe(2);

    const persisted = await db.select().from(schema.surfaceEvent);
    expect(persisted).toHaveLength(2);

    for (const event of persisted) {
      const pool = event.candidatePool;
      expect(pool).toHaveLength(5);
      const ids = pool.map((p: CandidatePoolEntry) => p.trackId).sort();
      expect(ids).toEqual(tracks.map((t) => t.id).sort());
      // Each event's pool flags ONLY its own winner as surfaced — read in
      // isolation, a single row identifies its own winner. Other broad
      // winners in the same batch live in their own surface_event rows.
      const surfacedFlags = pool.filter((p: CandidatePoolEntry) => p.surfaced);
      expect(surfacedFlags).toHaveLength(1);
      expect(surfacedFlags[0]?.trackId).toBe(event.trackId);
      const myWinner = pool.find((p: CandidatePoolEntry) => p.trackId === event.trackId);
      expect(myWinner?.surfaced).toBe(true);
      expect(myWinner?.score).toBeCloseTo(event.winnerScore, 9);
    }
  });

  it("counterfactual replay: rerunning the ranker against the persisted pool reproduces scores", async () => {
    // Ground-truth contract: a stored candidate_pool plus its model_version
    // must let an offline replay reproduce the original ranking. Phase 5's
    // counterfactual screen is built on this property.
    const tracks = [];
    for (let i = 0; i < 4; i++) {
      tracks.push(
        await insertTrack({
          title: `T${i}`,
          audioFeatures: audio({ valence: 0.2 + i * 0.2 }),
          genres: ["pop"],
        }),
      );
    }
    const candidates = await Promise.all(tracks.map(asCandidate));
    await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      dailyCapOverride: 2,
    });

    const events = await db.select().from(schema.surfaceEvent);
    const event = events[0];
    if (!event) throw new Error("expected at least one event");

    const broadConfig = (await getActiveConfig(db, "broad")) as BroadConfig;

    // Rebuild candidate inputs from the in-test sources, then rescore.
    const candidateById = new Map(candidates.map((c) => [c.trackId, c]));
    for (const entry of event.candidatePool) {
      const c = candidateById.get(entry.trackId);
      expect(c).toBeDefined();
      const replay = scoreBroad(c!, broadConfig);
      expect(replay.score).toBeCloseTo(entry.score, 9);
    }
  });

  it("refill mode persists the bucket scope alongside the keep-sim sub-scores", async () => {
    // Seed a bucket with two clearly-rock tracks, then surface in pure-refill
    // mode (novelty=0). Expect: surface_event.bucket_id set, ranker_kind=refill,
    // pool entries carry keepSim/dislikeSim sub-scores.
    const seed1 = await insertTrack({
      title: "Seed-1",
      audioFeatures: audio({ tempo: 130, energy: 0.7 }),
      genres: ["rock"],
    });
    const seed2 = await insertTrack({
      title: "Seed-2",
      audioFeatures: audio({ tempo: 132, energy: 0.72 }),
      genres: ["rock"],
    });
    await assignTrack(db, seed1.id, { spawnThreshold: 0.7 });
    await assignTrack(db, seed2.id, { spawnThreshold: 0.7 });

    const candTracks = [];
    for (let i = 0; i < 3; i++) {
      candTracks.push(
        await insertTrack({
          title: `Cand-${i}`,
          audioFeatures: audio({ tempo: 128 + i, energy: 0.65 }),
          genres: ["rock"],
        }),
      );
    }
    const candidates = await Promise.all(candTracks.map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      dailyCapOverride: 1,
    });
    expect(result.refillQuota).toBe(1);
    expect(result.broadQuota).toBe(0);
    expect(result.events).toHaveLength(1);

    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.rankerKind).toBe("refill");
    expect(event.bucketId).not.toBeNull();
    const winnerEntry = event.candidatePool.find(
      (p: CandidatePoolEntry) => p.trackId === event.trackId,
    );
    expect(winnerEntry?.surfaced).toBe(true);
    expect(typeof winnerEntry?.subScores?.keepSim).toBe("number");
    expect(typeof winnerEntry?.subScores?.dislikeSim).toBe("number");
  });

  it("model_version is attributed to every surface_event — Constraint #3", async () => {
    const tracks = [
      await insertTrack({ title: "A", audioFeatures: audio(), genres: ["rock"] }),
      await insertTrack({ title: "B", audioFeatures: audio({ energy: 0.8 }), genres: ["rock"] }),
    ];
    const candidates = await Promise.all(tracks.map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      dailyCapOverride: 2,
    });

    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.modelVersionId).toBe(result.broadModelVersionId);
    }
    const versionRow = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.id, result.broadModelVersionId));
    expect(versionRow[0]?.kind).toBe("broad");
  });
});

describe("runSurfacingBatch — caps live in surfacing, not ingestion (Constraint #5)", () => {
  it("daily cap trims surfaced count even when the candidate pool is huge", async () => {
    // 30 candidates, dailyCap=3. Surfacing must surface only 3 events; the
    // candidate_pool in each must still hold all 30 entries (ingestion is
    // not the cap layer).
    const tracks = [];
    for (let i = 0; i < 30; i++) {
      tracks.push(
        await insertTrack({
          title: `T${i}`,
          audioFeatures: audio({ energy: (i % 10) / 10 }),
          genres: ["rock"],
        }),
      );
    }
    const candidates = await Promise.all(tracks.map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      dailyCapOverride: 3,
      queueCeilingOverride: 50,
    });

    expect(result.events).toHaveLength(3);
    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.candidatePool).toHaveLength(30);
    }
  });

  it("queue ceiling further trims when the unrated queue is already deep", async () => {
    // Pre-populate 4 unrated surface events; queue ceiling = 5, daily cap = 10.
    // Effective cap = min(10, 5 − 4) = 1. So a fresh batch surfaces only 1.
    const seed = await insertTrack({
      title: "Already-surfaced anchor",
      audioFeatures: audio(),
      genres: ["rock"],
    });
    const seedCandidate = await asCandidate(seed);
    await runSurfacingBatch(db, {
      candidates: [seedCandidate],
      noveltyOverride: 1,
      dailyCapOverride: 1,
    });
    // Manually pad the queue to 4 unrated surface_events with the same model
    // version, by inserting bare rows referencing the bootstrapped version.
    const broad = await getActiveModelVersion(db, "broad");
    if (!broad) throw new Error("expected broad version after first run");
    for (let i = 0; i < 3; i++) {
      const t = await insertTrack({
        title: `Filler-${i}`,
        audioFeatures: audio(),
        genres: ["rock"],
      });
      await db.insert(schema.surfaceEvent).values({
        trackId: t.id,
        rankerKind: "broad",
        modelVersionId: broad.id,
        featuresAtDecision: audio(),
        winnerScore: 0,
        candidatePool: [],
      });
    }

    const fresh = [];
    for (let i = 0; i < 5; i++) {
      fresh.push(
        await insertTrack({
          title: `Fresh-${i}`,
          audioFeatures: audio({ energy: 0.3 + i * 0.1 }),
          genres: ["rock"],
        }),
      );
    }
    const candidates = await Promise.all(fresh.map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      dailyCapOverride: 10,
      queueCeilingOverride: 5,
    });
    expect(result.effectiveCap).toBe(1);
    expect(result.events).toHaveLength(1);
  });

  it("returns no events when the candidate pool is empty (degrades gracefully)", async () => {
    const result = await runSurfacingBatch(db, {
      candidates: [],
      noveltyOverride: 1,
      dailyCapOverride: 5,
    });
    expect(result.events).toHaveLength(0);
    expect(result.surfaced).toHaveLength(0);
  });
});

describe("runSurfacingBatch — soft penalties only (Constraint #4)", () => {
  it("disliked-genre candidates remain in the candidate_pool with reduced refill scores, not filtered", async () => {
    // Train a refill scenario where the user disliked a genre's anchor track.
    // Ingest a candidate carrying that genre. After surfacing, the candidate
    // MUST appear in the refill candidate_pool — its score is just lower.
    const seed = await insertTrack({
      title: "Seed (rock keep-anchor)",
      audioFeatures: audio({ tempo: 130, energy: 0.7 }),
      genres: ["rock"],
    });
    await assignTrack(db, seed.id, { spawnThreshold: 0.7 });

    // A disliked rock track adds a global negative signal for refill.
    const dislikedAnchor = await insertTrack({
      title: "Dislike-anchor",
      audioFeatures: audio({ tempo: 60, energy: 0.1, acousticness: 0.9 }),
      genres: ["rock"],
    });
    // Ratings need a model_version_id — bootstrap one. The active broad
    // version is created by ensureActiveModelVersion and will do.
    const broadVer = await ensureActiveModelVersion(db, "broad");
    await db.insert(schema.rating).values({
      trackId: dislikedAnchor.id,
      decision: "dislike",
      modelVersionId: broadVer.id,
    });

    // A candidate that LOOKS like the disliked anchor — same audio + genre.
    // Refill scoring must still include it in the pool with a (low) score.
    const dislikedShape = await insertTrack({
      title: "Disliked-genre candidate",
      audioFeatures: audio({ tempo: 60, energy: 0.1, acousticness: 0.9 }),
      genres: ["rock"],
    });
    const happyShape = await insertTrack({
      title: "Keep-shape candidate",
      audioFeatures: audio({ tempo: 130, energy: 0.7 }),
      genres: ["rock"],
    });
    const candidates = await Promise.all([dislikedShape, happyShape].map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0, // pure refill, deterministic
      dailyCapOverride: 1,
    });
    expect(result.events).toHaveLength(1);
    const event = (await db.select().from(schema.surfaceEvent))[0]!;
    expect(event.rankerKind).toBe("refill");
    const ids = event.candidatePool.map((p: CandidatePoolEntry) => p.trackId);
    expect(ids).toContain(dislikedShape.id);
    expect(ids).toContain(happyShape.id);

    const dislikedEntry = event.candidatePool.find(
      (p: CandidatePoolEntry) => p.trackId === dislikedShape.id,
    );
    const happyEntry = event.candidatePool.find(
      (p: CandidatePoolEntry) => p.trackId === happyShape.id,
    );
    expect(dislikedEntry?.surfaced).toBe(false);
    expect(happyEntry?.surfaced).toBe(true);
    // Refill score: keep_sim − λ·dislike_sim. The keep-shape candidate is
    // closer to keeps and far from dislikes; the disliked-shape is the
    // mirror. `score(disliked) < score(happy)`.
    expect(dislikedEntry?.score ?? 0).toBeLessThan(happyEntry?.score ?? 0);
  });
});

describe("ensureActiveModelVersion + bumpModelVersion", () => {
  it("first call mints an initial bootstrap version and second call returns it unchanged", async () => {
    const a = await ensureActiveModelVersion(db, "refill");
    const b = await ensureActiveModelVersion(db, "refill");
    expect(b.id).toBe(a.id);
  });

  it("bumping refill links new version to the previous active and swings the pointer", async () => {
    const v1 = await ensureActiveModelVersion(db, "refill");
    const v2 = await bumpModelVersion(db, "refill", { lambda: 0.7 });
    expect(v2.parentId).toBe(v1.id);

    const active = await getActiveModelVersion(db, "refill");
    expect(active?.id).toBe(v2.id);
  });

  it("bumping broad is independent of refill versioning — separate chains", async () => {
    const r1 = await ensureActiveModelVersion(db, "refill");
    const b1 = await ensureActiveModelVersion(db, "broad");
    const b2 = await bumpModelVersion(db, "broad", {
      weights: [0.1, 0.2],
      bias: 0,
      trainedSampleCount: 10,
    });
    expect(b2.parentId).toBe(b1.id);

    const refillActive = await getActiveModelVersion(db, "refill");
    const broadActive = await getActiveModelVersion(db, "broad");
    expect(refillActive?.id).toBe(r1.id);
    expect(broadActive?.id).toBe(b2.id);
  });
});

describe("counterfactual replay determinism", () => {
  it("refill: rerunning the ranker against the persisted pool reproduces scores within float32 tolerance", async () => {
    // Counterfactual replay against a refill event. The persisted candidate
    // pool plus the active refill model_version must allow an offline rerank
    // to reproduce sub-scores. (Audio features round-tripping through
    // pgvector/jsonb is the reason we tolerate float32 precision.)
    const seed = await insertTrack({
      title: "Anchor",
      audioFeatures: audio({ tempo: 125, energy: 0.6 }),
      genres: ["rock"],
    });
    await assignTrack(db, seed.id, { spawnThreshold: 0.7 });

    const c1 = await insertTrack({
      title: "C1",
      audioFeatures: audio({ tempo: 124, energy: 0.59 }),
      genres: ["rock"],
    });
    const c2 = await insertTrack({
      title: "C2",
      audioFeatures: audio({ tempo: 130, energy: 0.65 }),
      genres: ["rock"],
    });
    const candidates = await Promise.all([c1, c2].map(asCandidate));

    await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      dailyCapOverride: 1,
    });

    const event = (await db.select().from(schema.surfaceEvent))[0]!;
    const refillConfig = await getActiveConfig(db, "refill");

    // Replay against the bucket members only — same shape the original run used.
    const seedRow = await db.select().from(schema.track).where(eq(schema.track.id, seed.id));
    const keeps = [{ trackId: seed.id, embedding: seedRow[0]!.embedding ?? [] }];

    for (const entry of event.candidatePool) {
      const cand = candidates.find((c) => c.trackId === entry.trackId);
      expect(cand).toBeDefined();
      const replay = scoreRefill(cand!, keeps, [], refillConfig);
      expect(replay.score).toBeCloseTo(entry.score, 5);
    }
  });
});
