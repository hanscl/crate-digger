import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { count, eq, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { AudioFeatures, CandidatePoolEntry } from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { buildEmbedding, derivePrimaryGenre, weightedCosine } from "@/lib/embedding";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import { scoreBroad } from "@/lib/ranking/broad";
import { scoreRefill } from "@/lib/ranking/refill";
import type { Candidate } from "@/lib/ranking/types";
import {
  bumpModelVersion,
  configFromVersion,
  ensureActiveModelVersion,
  getActiveModelVersion,
  getModelVersion,
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
}): Promise<{ id: number; embedding: number[]; audio: AudioFeatures | null; genres: string[] }> {
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
      // assignTrack derives + persists this on first assignment, but seeding it
      // here keeps candidates and bucket genres in lockstep for refill tests.
      primaryGenre: derivePrimaryGenre(opts.genres),
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return { id: row.id, embedding, audio: opts.audioFeatures, genres: opts.genres };
}

async function asCandidate(t: {
  id: number;
  embedding: number[];
  audio: AudioFeatures | null;
  genres: string[];
}): Promise<Candidate> {
  return {
    trackId: t.id,
    embedding: t.embedding,
    audioFeatures: t.audio,
    // Mirror the derived primary genre so the refill winner-eligibility gate
    // (same primary genre as the target bucket) matches in-genre candidates.
    primaryGenre: derivePrimaryGenre(t.genres),
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
      noveltyOverride: 1,
      queueCeilingOverride: 2,
    });

    expect(result.events).toHaveLength(2);
    expect(result.refillSurfacedCount).toBe(0);
    expect(result.broadSurfacedCount).toBe(2);

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
      queueCeilingOverride: 2,
    });

    const events = await db.select().from(schema.surfaceEvent);
    const event = events[0];
    if (!event) throw new Error("expected at least one event");

    // Resolve config from THIS event's pinned model_version_id, not the
    // active pointer — replay must reproduce against the version the event
    // was logged under, even if a later bump moves the active pointer.
    const versionRow = await getModelVersion(db, event.modelVersionId);
    if (!versionRow) throw new Error("expected model_version row for event");
    const broadConfig = configFromVersion(versionRow, "broad");

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
    await assignTrack(db, seed1.id, { origin: "seed_track", spawnThreshold: 0.7 });
    await assignTrack(db, seed2.id, { origin: "seed_track", spawnThreshold: 0.7 });

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
      refillBarOverride: 0,
      queueCeilingOverride: 1,
    });
    expect(result.refillSurfacedCount).toBe(1);
    expect(result.broadSurfacedCount).toBe(0);
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
      queueCeilingOverride: 2,
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

describe("runSurfacingBatch — quality-gated surfacing (LAB-53: quality bar + queue ceiling)", () => {
  it("the queue ceiling bounds surfaced count even when the candidate pool is huge", async () => {
    // 30 candidates, queueCeiling=3. Surfacing emits only 3 events; each
    // candidate_pool must still hold all 30 entries (ingestion is not the cap
    // layer — Constraint #2).
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
      noveltyOverride: 1, // pure broad; cold-start prior 0.5 clears the 0.5 broad bar
      queueCeilingOverride: 3,
    });

    expect(result.events).toHaveLength(3);
    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.candidatePool).toHaveLength(30);
    }
  });

  it("queue ceiling is the only count bound — effectiveCap shrinks as the unrated queue deepens", async () => {
    // Pre-populate 4 unrated surface events; queue ceiling = 5.
    // effectiveCap = queueCeiling − unrated = 5 − 4 = 1 → a fresh batch surfaces 1.
    const seed = await insertTrack({
      title: "Already-surfaced anchor",
      audioFeatures: audio(),
      genres: ["rock"],
    });
    const seedCandidate = await asCandidate(seed);
    await runSurfacingBatch(db, {
      candidates: [seedCandidate],
      noveltyOverride: 1,
      queueCeilingOverride: 1,
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
      queueCeilingOverride: 5,
    });
    expect(result.effectiveCap).toBe(1);
    expect(result.events).toHaveLength(1);
  });

  it("returns no events when the candidate pool is empty (degrades gracefully)", async () => {
    const result = await runSurfacingBatch(db, {
      candidates: [],
      noveltyOverride: 1,
      queueCeilingOverride: 5,
    });
    expect(result.events).toHaveLength(0);
    expect(result.surfaced).toHaveLength(0);
  });

  it("drops below-bar candidates entirely — a bar above the cold-start prior surfaces nothing", async () => {
    // LAB-53 quality bar: a broad score must clear broadBar to surface. The
    // cold-start broad prior is 0.5; a bar of 0.9 drops everything. Dropped
    // tracks get NO surface_event (they stay enriched + candidate-flagged).
    const tracks = [];
    for (let i = 0; i < 3; i++) {
      tracks.push(await insertTrack({ title: `T${i}`, audioFeatures: audio(), genres: ["rock"] }));
    }
    const candidates = await Promise.all(tracks.map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      broadBarOverride: 0.9,
      queueCeilingOverride: 50,
    });
    expect(result.surfaced).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(await db.select().from(schema.surfaceEvent)).toHaveLength(0);
  });

  it("surfaces every above-bar candidate up to the ceiling (dynamic count, not a fixed quota)", async () => {
    // 4 candidates all clear a 0.5 broad bar (the cold-start prior); the ceiling
    // (50) doesn't bind → all 4 surface. The count is driven by the bar, not a
    // pre-allocated quota.
    const tracks = [];
    for (let i = 0; i < 4; i++) {
      tracks.push(
        await insertTrack({
          title: `T${i}`,
          audioFeatures: audio({ energy: 0.2 + i * 0.1 }),
          genres: ["rock"],
        }),
      );
    }
    const candidates = await Promise.all(tracks.map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      broadBarOverride: 0.5,
      queueCeilingOverride: 50,
    });
    expect(result.surfaced).toHaveLength(4);
    expect(result.events).toHaveLength(4);
    expect(result.broadSurfacedCount).toBe(4);
  });

  it("refill surfaces EVERY above-bar candidate for a bucket (>1/bucket), not a round-robin top-1", async () => {
    // LAB-53 headline: refill is no longer top-1-per-bucket. Three on-genre
    // candidates that clear the refill bar all surface against the one bucket.
    const seed = await insertTrack({
      title: "Anchor",
      audioFeatures: audio({ tempo: 130, energy: 0.7 }),
      genres: ["rock"],
    });
    const seedAssign = await assignTrack(db, seed.id, {
      origin: "seed_track",
      spawnThreshold: 0.7,
    });

    const candTracks = [];
    for (let i = 0; i < 3; i++) {
      candTracks.push(
        await insertTrack({
          title: `Cand-${i}`,
          audioFeatures: audio({ tempo: 129 + i, energy: 0.68 }),
          genres: ["rock"],
        }),
      );
    }
    const candidates = await Promise.all(candTracks.map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      refillBarOverride: 0, // every on-genre candidate clears the bar
      broadBarOverride: 1, // broad never fills
      queueCeilingOverride: 50,
    });
    expect(result.surfaced).toHaveLength(3);
    for (const s of result.surfaced) expect(s.rankerKind).toBe("refill");
    expect(result.refillSurfacedCount).toBe(3);
    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(3);
    for (const e of events) expect(e.bucketId).toBe(seedAssign.bucketId);
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
    await assignTrack(db, seed.id, { origin: "seed_track", spawnThreshold: 0.7 });

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
      noveltyOverride: 0,
      refillBarOverride: 0,
      queueCeilingOverride: 1,
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

describe("runSurfacingBatch — refill genre winner-eligibility gate (LAB-45, config-selected per LAB-36)", () => {
  it("a slot-disjoint candidate that tops keep-similarity still cannot WIN a refill slot, but stays in candidate_pool", async () => {
    // Mirror of the JOIN gate (assign.ts): an indie-primary track ("the cure")
    // can score the highest raw keep-similarity against a metal bucket yet
    // must never win a refill slot for it — under the LAB-36 slot-overlap
    // gate its {indie} slots share nothing with the bucket's {metal} mass
    // (and under the legacy exact gate the lanes differ outright), so it
    // could never JOIN that bucket. The in-genre metal candidate wins
    // instead. Constraint #2 is preserved: the indie candidate is still
    // scored into the pool.
    const metalSeed = await insertTrack({
      title: "Heavy Metal Thunder (seed)",
      audioFeatures: audio({
        tempo: 160,
        energy: 0.98,
        valence: 0.3,
        danceability: 0.4,
        acousticness: 0.02,
        instrumentalness: 0.2,
      }),
      genres: ["heavy metal"],
    });
    // Spawns a metal-primary bucket with the seed as its sole keep anchor.
    const seedAssign = await assignTrack(db, metalSeed.id, {
      origin: "seed_track",
      spawnThreshold: 0.7,
    });
    expect(seedAssign.spawned).toBe(true);
    expect(seedAssign.primaryGenre).toBe("metal");

    // In-genre metal candidate: same primary genre, audio deliberately the
    // OPPOSITE shape so its raw keep-cosine is LOWER than the indie's.
    const metalCand = await insertTrack({
      title: "Slow Acoustic Metal",
      audioFeatures: audio({
        tempo: 70,
        energy: 0.05,
        valence: 0.9,
        danceability: 0.95,
        acousticness: 0.98,
        instrumentalness: 0.95,
      }),
      genres: ["heavy metal"],
    });
    // The Cure: indie primary genre, audio nearly identical to the metal seed
    // so its RAW keep-cosine OTHERWISE tops the in-genre metal candidate.
    const indieCand = await insertTrack({
      title: "The Cure",
      audioFeatures: audio({
        tempo: 160,
        energy: 0.98,
        valence: 0.3,
        danceability: 0.4,
        acousticness: 0.02,
        instrumentalness: 0.2,
      }),
      genres: ["indie"],
    });
    const candidates = await Promise.all([metalCand, indieCand].map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      refillBarOverride: 0,
      queueCeilingOverride: 1,
    });

    expect(result.events).toHaveLength(1);
    const event = (await db.select().from(schema.surfaceEvent))[0]!;
    expect(event.rankerKind).toBe("refill");
    // (3) The refill happened against the metal bucket.
    expect(event.bucketId).toBe(seedAssign.bucketId);

    // (1) The surfaced winner is the in-genre metal candidate, NEVER the indie.
    expect(event.trackId).toBe(metalCand.id);
    expect(event.trackId).not.toBe(indieCand.id);
    expect(result.surfaced).toHaveLength(1);
    expect(result.surfaced[0]?.candidate.trackId).toBe(metalCand.id);

    // Sanity: prove it was the GATE, not cosine, that excluded the indie —
    // the indie's raw keep-sim must OTHERWISE top the metal candidate's.
    const indiePoolEntry = event.candidatePool.find(
      (p: CandidatePoolEntry) => p.trackId === indieCand.id,
    );
    const metalPoolEntry = event.candidatePool.find(
      (p: CandidatePoolEntry) => p.trackId === metalCand.id,
    );
    expect(indiePoolEntry?.subScores?.keepSim ?? 0).toBeGreaterThan(
      metalPoolEntry?.subScores?.keepSim ?? 0,
    );

    // (2) Constraint #2: the off-genre indie candidate STILL appears in the
    // logged candidate_pool, flagged surfaced=false — never trimmed.
    const ids = event.candidatePool.map((p: CandidatePoolEntry) => p.trackId);
    expect(ids).toContain(indieCand.id);
    expect(ids).toContain(metalCand.id);
    expect(indiePoolEntry?.surfaced).toBe(false);
    expect(metalPoolEntry?.surfaced).toBe(true);
  });

  it("slot-overlap config: a cross-lane candidate sharing a slot CAN win a refill slot (impossible under LAB-45 exact)", async () => {
    // Rock-primary bucket; indie-primary candidate whose "indie rock" tag
    // shares the rock slot. The bootstrap refill config is the LAB-36 one
    // (slot-overlap), so the candidate is winner-eligible across the lane —
    // membership (JOIN) and surfacing (winner gate) move together.
    const rockSeed = await insertTrack({
      title: "Rock seed",
      audioFeatures: audio({ tempo: 128, energy: 0.7 }),
      genres: ["rock"],
    });
    const seedAssign = await assignTrack(db, rockSeed.id, {
      origin: "seed_track",
      spawnThreshold: 0.7,
    });
    expect(seedAssign.primaryGenre).toBe("rock");

    const indieCand = await insertTrack({
      title: "Indie rock candidate",
      audioFeatures: audio({ tempo: 127, energy: 0.69 }),
      genres: ["indie rock"],
    });
    const candidates = await Promise.all([indieCand].map(asCandidate));
    expect(candidates[0]?.primaryGenre).toBe("indie");

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      refillBarOverride: 0,
      broadBarOverride: 1,
      queueCeilingOverride: 1,
    });
    expect(result.refillSurfacedCount).toBe(1);
    const event = (await db.select().from(schema.surfaceEvent))[0]!;
    expect(event.rankerKind).toBe("refill");
    expect(event.bucketId).toBe(seedAssign.bucketId);
    expect(event.trackId).toBe(indieCand.id);
  });

  it("legacy exact config: the SAME cross-lane candidate cannot win — the version's genreGate drives the gate", async () => {
    // Pin a legacy {lambda}-only refill version as active BEFORE surfacing.
    // ensureActiveModelVersion returns it untouched, so the winner gate runs
    // 'exact' and the cross-lane candidate is ineligible — proving the gate
    // is selected per model_version config, not hardcoded.
    await bumpModelVersion(db, "refill", { lambda: 0.3 }, { note: "legacy pin" });

    const rockSeed = await insertTrack({
      title: "Rock seed",
      audioFeatures: audio({ tempo: 128, energy: 0.7 }),
      genres: ["rock"],
    });
    const seedAssign = await assignTrack(db, rockSeed.id, {
      origin: "seed_track",
      spawnThreshold: 0.7,
    });
    expect(seedAssign.primaryGenre).toBe("rock");

    const indieCand = await insertTrack({
      title: "Indie rock candidate",
      audioFeatures: audio({ tempo: 127, energy: 0.69 }),
      genres: ["indie rock"],
    });
    const candidates = await Promise.all([indieCand].map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      refillBarOverride: 0,
      broadBarOverride: 1,
      queueCeilingOverride: 1,
    });
    // Gate-ineligible for the only refillable bucket → nothing surfaces
    // (broad bar pinned at 1 so refill is the only path).
    expect(result.refillSurfacedCount).toBe(0);
    expect(result.surfaced).toHaveLength(0);
  });

  it("the null===null rule: a null-genre candidate can win a refill slot for a null-genre bucket", async () => {
    // Sanity for the null-handling branch of sameGenreScope. A bucket spawned
    // from a genre-less seed has primaryGenre=null; a genre-less candidate
    // (primaryGenre derived to null) matches it and is eligible to win.
    const nullSeed = await insertTrack({
      title: "Genreless seed",
      audioFeatures: audio({ tempo: 125, energy: 0.6 }),
      genres: [],
    });
    const seedAssign = await assignTrack(db, nullSeed.id, {
      origin: "seed_track",
      spawnThreshold: 0.7,
    });
    expect(seedAssign.primaryGenre).toBeNull();

    const nullCand = await insertTrack({
      title: "Genreless candidate",
      audioFeatures: audio({ tempo: 124, energy: 0.59 }),
      genres: [],
    });
    const candidates = await Promise.all([nullCand].map(asCandidate));
    expect(candidates[0]?.primaryGenre).toBeNull();

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      refillBarOverride: 0,
      queueCeilingOverride: 1,
    });

    expect(result.events).toHaveLength(1);
    const event = (await db.select().from(schema.surfaceEvent))[0]!;
    expect(event.rankerKind).toBe("refill");
    expect(event.bucketId).toBe(seedAssign.bucketId);
    expect(event.trackId).toBe(nullCand.id);
  });
});

describe("runSurfacingBatch — decided/pending eligibility gate (LAB-60)", () => {
  it("a previously-disliked track is not re-surfaced and is absent from the candidate_pool", async () => {
    // Eligibility gate, not a taste penalty: the disliked track itself never
    // re-enters the pool, while its dislike signal keeps downweighting OTHER
    // candidates (Constraint #4 coverage lives in the soft-penalties suite).
    const disliked = await insertTrack({
      title: "Disliked",
      audioFeatures: audio({ energy: 0.3 }),
      genres: ["rock"],
    });
    const control = await insertTrack({
      title: "Control",
      audioFeatures: audio({ energy: 0.6 }),
      genres: ["rock"],
    });
    const broadVer = await ensureActiveModelVersion(db, "broad");
    await db.insert(schema.rating).values({
      trackId: disliked.id,
      decision: "dislike",
      modelVersionId: broadVer.id,
    });

    const result = await runSurfacingBatch(db, {
      candidates: await Promise.all([disliked, control].map(asCandidate)),
      noveltyOverride: 1,
      queueCeilingOverride: 50,
    });

    expect(result.excludedDecidedCount).toBe(1);
    expect(result.excludedPendingCount).toBe(0);
    expect(result.surfaced).toHaveLength(1);
    expect(result.surfaced[0]?.candidate.trackId).toBe(control.id);

    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(1);
    expect(events[0]?.trackId).toBe(control.id);
    // Excluded BEFORE scoring — the decided track never enters the pool.
    const poolIds = events[0]!.candidatePool.map((p: CandidatePoolEntry) => p.trackId);
    expect(poolIds).not.toContain(disliked.id);
    expect(poolIds).toContain(control.id);
  });

  it("a kept bucket member does not re-surface into its own bucket under pure refill", async () => {
    // LAB-39's similar pull re-pulls tracks near bucket centroids — the kept
    // member IS the centroid anchor, so without the gate it would top its own
    // bucket's keep-similarity and re-queue as a fresh card.
    const kept = await insertTrack({
      title: "Kept member",
      audioFeatures: audio({ tempo: 130, energy: 0.7 }),
      genres: ["rock"],
    });
    // Route the keep through ingestRating so the LAB-52 commit path spawns
    // the bucket with the kept track as its member/anchor.
    const ingest = await ingestRating(db, { trackId: kept.id, decision: "keep" });
    expect(ingest.committedBucketId).not.toBeNull();

    const fresh = await insertTrack({
      title: "Fresh in-genre",
      audioFeatures: audio({ tempo: 129, energy: 0.68 }),
      genres: ["rock"],
    });

    const result = await runSurfacingBatch(db, {
      candidates: await Promise.all([kept, fresh].map(asCandidate)),
      noveltyOverride: 0,
      refillBarOverride: 0,
      broadBarOverride: 1, // broad never fills — pure refill
      queueCeilingOverride: 50,
    });

    expect(result.excludedDecidedCount).toBe(1);
    expect(result.surfaced).toHaveLength(1);
    expect(result.surfaced[0]?.candidate.trackId).toBe(fresh.id);
    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(1);
    expect(events[0]?.rankerKind).toBe("refill");
    expect(events[0]?.trackId).toBe(fresh.id);
  });

  it("a previously-deferred track re-surfaces — defer means later, not no", async () => {
    const t = await insertTrack({ title: "Deferred", audioFeatures: audio(), genres: ["rock"] });
    const cand = await asCandidate(t);
    await runSurfacingBatch(db, {
      candidates: [cand],
      noveltyOverride: 1,
      queueCeilingOverride: 50,
    });
    const [first] = await db.select().from(schema.surfaceEvent);
    expect(first).toBeDefined();
    await ingestRating(db, { trackId: t.id, decision: "defer", surfaceEventId: first!.id });

    const result = await runSurfacingBatch(db, {
      candidates: [cand],
      noveltyOverride: 1,
      queueCeilingOverride: 50,
    });
    expect(result.excludedDecidedCount).toBe(0);
    expect(result.excludedPendingCount).toBe(0);
    expect(result.surfaced).toHaveLength(1);
    const events = await db
      .select()
      .from(schema.surfaceEvent)
      .where(eq(schema.surfaceEvent.trackId, t.id));
    expect(events).toHaveLength(2);
  });

  it("a surfaced-but-unrated track is not surfaced again — no duplicate queue cards", async () => {
    const t = await insertTrack({ title: "Pending", audioFeatures: audio(), genres: ["rock"] });
    const cand = await asCandidate(t);
    await runSurfacingBatch(db, {
      candidates: [cand],
      noveltyOverride: 1,
      queueCeilingOverride: 50,
    });

    // Re-run with ceiling headroom to spare — the dedupe, not the ceiling,
    // must be what blocks the duplicate.
    const result = await runSurfacingBatch(db, {
      candidates: [cand],
      noveltyOverride: 1,
      queueCeilingOverride: 50,
    });
    expect(result.excludedPendingCount).toBe(1);
    expect(result.excludedDecidedCount).toBe(0);
    expect(result.surfaced).toHaveLength(0);
    expect(result.events).toHaveLength(0);

    expect(await db.select().from(schema.surfaceEvent)).toHaveLength(1);
    // The queue-depth predicate (unrated surface events) still sees ONE card.
    const [depth] = await db
      .select({ n: count() })
      .from(schema.surfaceEvent)
      .leftJoin(schema.rating, eq(schema.rating.surfaceEventId, schema.surfaceEvent.id))
      .where(isNull(schema.rating.id));
    expect(Number(depth?.n ?? 0)).toBe(1);
  });

  it("mixed pool: candidate_pool carries deferred + fresh but never the decided track", async () => {
    const disliked = await insertTrack({
      title: "Decided (dislike)",
      audioFeatures: audio({ energy: 0.2 }),
      genres: ["rock"],
    });
    const deferred = await insertTrack({
      title: "Deferred",
      audioFeatures: audio({ energy: 0.5 }),
      genres: ["rock"],
    });
    const fresh = await insertTrack({
      title: "Fresh",
      audioFeatures: audio({ energy: 0.8 }),
      genres: ["rock"],
    });
    const broadVer = await ensureActiveModelVersion(db, "broad");
    await db.insert(schema.rating).values([
      { trackId: disliked.id, decision: "dislike", modelVersionId: broadVer.id },
      { trackId: deferred.id, decision: "defer", modelVersionId: broadVer.id },
    ]);

    const result = await runSurfacingBatch(db, {
      candidates: await Promise.all([disliked, deferred, fresh].map(asCandidate)),
      noveltyOverride: 1,
      queueCeilingOverride: 50,
    });
    expect(result.excludedDecidedCount).toBe(1);
    expect(result.excludedPendingCount).toBe(0);
    expect(result.surfaced.map((s) => s.candidate.trackId).sort((a, b) => a - b)).toEqual(
      [deferred.id, fresh.id].sort((a, b) => a - b),
    );

    const events = await db.select().from(schema.surfaceEvent);
    expect(events).toHaveLength(2);
    for (const e of events) {
      const ids = e.candidatePool.map((p: CandidatePoolEntry) => p.trackId).sort((a, b) => a - b);
      expect(ids).toEqual([deferred.id, fresh.id].sort((a, b) => a - b));
    }
  });

  it("a track with both defer and dislike rows is excluded — any keep/dislike ever decides", async () => {
    const t = await insertTrack({
      title: "Defer then dislike",
      audioFeatures: audio(),
      genres: ["rock"],
    });
    const broadVer = await ensureActiveModelVersion(db, "broad");
    await db.insert(schema.rating).values([
      { trackId: t.id, decision: "defer", modelVersionId: broadVer.id },
      { trackId: t.id, decision: "dislike", modelVersionId: broadVer.id },
    ]);

    const result = await runSurfacingBatch(db, {
      candidates: [await asCandidate(t)],
      noveltyOverride: 1,
      queueCeilingOverride: 50,
    });
    expect(result.excludedDecidedCount).toBe(1);
    expect(result.surfaced).toHaveLength(0);
    expect(await db.select().from(schema.surfaceEvent)).toHaveLength(0);
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
      weights: Array.from({ length: 64 }, (_, i) => i * 0.01),
      bias: 0,
      trainedSampleCount: 10,
    });
    expect(b2.parentId).toBe(b1.id);

    const refillActive = await getActiveModelVersion(db, "refill");
    const broadActive = await getActiveModelVersion(db, "broad");
    expect(refillActive?.id).toBe(r1.id);
    expect(broadActive?.id).toBe(b2.id);
  });

  it("surfacing pins config to the same version it logs — no config/version-id divergence", async () => {
    // Regression for the race where a concurrent bumpModelVersion between
    // ensureActiveModelVersion and a fresh getActiveConfig would log events
    // at version N's id while scoring with version N+1's config. Replay
    // against the persisted version's config must reproduce winnerScore
    // exactly — proving the same version's config was used to score.
    const t1 = await insertTrack({
      title: "T1",
      audioFeatures: audio({ valence: 0.4 }),
      genres: ["rock"],
    });
    const t2 = await insertTrack({
      title: "T2",
      audioFeatures: audio({ valence: 0.6 }),
      genres: ["rock"],
    });
    const candidates = await Promise.all([t1, t2].map(asCandidate));

    await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 1,
      queueCeilingOverride: 1,
    });
    const eventV1 = (await db.select().from(schema.surfaceEvent))[0]!;

    // Drop a fresh broad version with very different weights — simulating
    // what a retrain triggered mid-flight would do.
    await bumpModelVersion(db, "broad", {
      weights: Array.from({ length: 64 }, () => 99),
      bias: 99,
      trainedSampleCount: 1,
    });

    // Reload the version the event was logged against, narrow its config,
    // and rescore — winnerScore must match. If divergence were possible,
    // event.winnerScore would have been computed under the (now-superseded)
    // bootstrap config, but the active version row at scoring time would be
    // the new one — replay against either side would mismatch.
    const persistedVersion = await getActiveModelVersion(db, "broad");
    expect(persistedVersion?.id).not.toBe(eventV1.modelVersionId);
    const eventVersionRow = (
      await db
        .select()
        .from(schema.modelVersion)
        .where(sql`${schema.modelVersion.id} = ${eventV1.modelVersionId}`)
    )[0]!;

    const replayConfig = configFromVersion(eventVersionRow, "broad");
    const winnerCand = candidates.find((c) => c.trackId === eventV1.trackId)!;
    const replayScore = scoreBroad(winnerCand, replayConfig).score;
    expect(replayScore).toBeCloseTo(eventV1.winnerScore, 9);
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
    await assignTrack(db, seed.id, { origin: "seed_track", spawnThreshold: 0.7 });

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
      refillBarOverride: 0,
      queueCeilingOverride: 1,
    });

    const event = (await db.select().from(schema.surfaceEvent))[0]!;
    const versionRow = await getModelVersion(db, event.modelVersionId);
    if (!versionRow) throw new Error("expected model_version row for event");
    const refillConfig = configFromVersion(versionRow, "refill");

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

describe("runSurfacingBatch — LAB-61 keep-anchor cleanup", () => {
  it("a bucket emptied by the legacy-membership cleanup is no longer refillable", async () => {
    // Shape the 0010 backfill leaves behind for a bucket whose only member
    // was eager-joined cruft: the membership row is gone (the bucket row may
    // briefly linger until the reconcile sweep prunes it). With no members
    // there is no keep-set — refill must not anchor on the empty bucket.
    const seed = await insertTrack({
      title: "Legacy-only anchor",
      audioFeatures: audio({ tempo: 130, energy: 0.7 }),
      genres: ["rock"],
    });
    const seedAssign = await assignTrack(db, seed.id, {
      origin: "seed_track",
      spawnThreshold: 0.7,
    });
    await db
      .delete(schema.bucketMember)
      .where(eq(schema.bucketMember.bucketId, seedAssign.bucketId));

    const cand = await insertTrack({
      title: "Would-be refill",
      audioFeatures: audio({ tempo: 130, energy: 0.7 }),
      genres: ["rock"],
    });
    const candidates = await Promise.all([cand].map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      refillBarOverride: 0,
      broadBarOverride: 1, // broad never fills — isolates the refill phase
      queueCeilingOverride: 50,
    });
    expect(result.refillSurfacedCount).toBe(0);
    expect(result.refilledBucketIds).toEqual([]);
    expect(result.events).toHaveLength(0);
  });

  it("keepSim is computed only over surviving members after a legacy member is removed", async () => {
    // Two same-genre members with deliberately opposite audio shapes; the
    // second (the "disliked legacy" stand-in) is then deleted the way the
    // 0010 cleanup deletes it. A candidate identical to the REMOVED member
    // must score keepSim against the survivor alone — not self-anchor at
    // the old (cos+1)/2 mean.
    const survivor = await insertTrack({
      title: "Surviving seed",
      audioFeatures: audio({ tempo: 130, energy: 0.7 }),
      genres: ["rock"],
    });
    const legacy = await insertTrack({
      title: "Disliked legacy member",
      audioFeatures: audio({ tempo: 60, energy: 0.1, acousticness: 0.9 }),
      genres: ["rock"],
    });
    const seedAssign = await assignTrack(db, survivor.id, {
      origin: "seed_track",
      spawnThreshold: 0.7,
    });
    // Same genre + spawnThreshold 0 → joins the survivor's bucket regardless
    // of audio distance (embeddings are non-negative, so cosine ≥ 0).
    const legacyAssign = await assignTrack(db, legacy.id, {
      origin: "seed_track",
      spawnThreshold: 0,
    });
    expect(legacyAssign.bucketId).toBe(seedAssign.bucketId);
    await db.delete(schema.bucketMember).where(eq(schema.bucketMember.trackId, legacy.id));

    const cand = await insertTrack({
      title: "Looks like the removed member",
      audioFeatures: audio({ tempo: 60, energy: 0.1, acousticness: 0.9 }),
      genres: ["rock"],
    });
    const candidates = await Promise.all([cand].map(asCandidate));

    const result = await runSurfacingBatch(db, {
      candidates,
      noveltyOverride: 0,
      refillBarOverride: 0,
      broadBarOverride: 1,
      queueCeilingOverride: 50,
    });
    expect(result.refillSurfacedCount).toBe(1);

    const event = (await db.select().from(schema.surfaceEvent))[0]!;
    const entry = event.candidatePool.find((pe: CandidatePoolEntry) => pe.trackId === cand.id);
    // Recompute under the metric of the version the event was scored with
    // (LAB-36: the bootstrap config carries audioWeight).
    const eventVersion = await getModelVersion(db, event.modelVersionId);
    const eventConfig = configFromVersion(eventVersion!, "refill");
    const simToSurvivor = weightedCosine(
      cand.embedding,
      survivor.embedding,
      eventConfig.audioWeight ?? 1,
    );
    // keep-set = [survivor] only → keepSim is exactly the survivor similarity…
    expect(entry?.subScores?.keepSim).toBeCloseTo(simToSurvivor, 6);
    // …and strictly below the two-member mean the legacy self-anchor (cos=1
    // against itself) would have produced.
    expect(entry?.subScores?.keepSim ?? 1).toBeLessThan((simToSurvivor + 1) / 2);
  });
});
