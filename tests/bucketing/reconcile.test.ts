import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { reconcileBuckets } from "@/lib/bucketing/reconcile";
import { buildEmbedding } from "@/lib/embedding";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import {
  bumpModelVersion,
  ensureActiveModelVersion,
  getActiveModelVersion,
} from "@/lib/ranking/version";

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

async function insertTrack(opts: {
  title: string;
  audioFeatures: schema.AudioFeatures | null;
  genres: string[];
}): Promise<{ id: number; embedding: number[] }> {
  const embedding = buildEmbedding({ audioFeatures: opts.audioFeatures, genres: opts.genres });
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

/** Hand-seed a consistent bucket (1 member, member_count=1) with a pinned centroid. */
async function seedConsistentBucket(opts: {
  name: string;
  primaryGenre: string;
  centroid: number[];
}): Promise<number> {
  const t = await insertTrack({ title: `${opts.name} member`, audioFeatures: null, genres: [] });
  const [b] = await db
    .insert(schema.bucket)
    .values({
      name: opts.name,
      centroid: opts.centroid,
      featureStats: {
        count: 0,
        mean: audio({
          tempo: 0,
          energy: 0,
          valence: 0,
          danceability: 0,
          acousticness: 0,
          instrumentalness: 0,
        }),
        m2: audio({
          tempo: 0,
          energy: 0,
          valence: 0,
          danceability: 0,
          acousticness: 0,
          instrumentalness: 0,
        }),
      },
      memberCount: 1,
      primaryGenre: opts.primaryGenre,
    })
    .returning({ id: schema.bucket.id });
  if (!b) throw new Error("bucket insert returned no rows");
  await db
    .insert(schema.bucketMember)
    .values({ bucketId: b.id, trackId: t.id, similarityAtJoin: 1, origin: "seed_track" });
  return b.id;
}

describe("reconcileBuckets — LAB-61 post-migration sweep", () => {
  it("repairs drift, prunes empties, rebuilds recommendations, and bumps refill exactly once", async () => {
    const refillV1 = await ensureActiveModelVersion(db, "refill");

    // Bucket A: two members via the normal path; one membership then deleted
    // raw (the 0010 cleanup shape) → member_count drifts 2 vs 1. The deleted
    // member carries a dislike so dislike_count must drop on recompute.
    const keepA = await insertTrack({
      title: "A keeper",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    const dislikedA = await insertTrack({
      title: "A disliked legacy",
      audioFeatures: audio({ tempo: 131 }),
      genres: ["rock"],
    });
    const aAssign = await assignTrack(db, keepA.id, { origin: "seed_track", spawnThreshold: 0.7 });
    await assignTrack(db, dislikedA.id, { origin: "seed_track", spawnThreshold: 0.7 });
    await ingestRating(db, { trackId: dislikedA.id, decision: "dislike" });
    await db.delete(schema.bucketMember).where(eq(schema.bucketMember.trackId, dislikedA.id));

    // Bucket B: hand-seeded, then its only membership deleted raw → empty,
    // must be pruned. A pending recommendation references it → stale.
    const bId = await seedConsistentBucket({
      name: "B (to prune)",
      primaryGenre: "idm",
      centroid: Array.from({ length: 64 }, () => 0.5),
    });
    await db.delete(schema.bucketMember).where(eq(schema.bucketMember.bucketId, bId));
    await db.insert(schema.bucketRecommendation).values({
      kind: "merge",
      bucketIds: [Math.min(bId, aAssign.bucketId), Math.max(bId, aAssign.bucketId)],
      reason: { similarity: 0.99, threshold: 0.92 },
      status: "pending",
    });

    // Buckets C & D: consistent near-twins → the rebuild re-derives their
    // merge recommendation after the sweep wipes pending rows.
    const twinCentroid = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 0.9 : 0.1));
    const cId = await seedConsistentBucket({
      name: "C",
      primaryGenre: "house",
      centroid: twinCentroid,
    });
    const dId = await seedConsistentBucket({
      name: "D",
      primaryGenre: "house",
      centroid: twinCentroid,
    });

    const result = await reconcileBuckets(db);

    expect(result.repaired).toBe(true);
    expect(result.driftedBucketIds.sort((x, y) => x - y)).toEqual([aAssign.bucketId, bId]);
    expect(result.prunedBucketIds).toEqual([bId]);
    expect(result.staleRecommendationCount).toBe(1);
    expect(result.recommendationsRebuilt).toBe(true);
    expect(result.refillVersionBumped).toBe(true);

    // A: recomputed from the surviving member.
    const [bucketA] = await db
      .select()
      .from(schema.bucket)
      .where(eq(schema.bucket.id, aAssign.bucketId));
    expect(bucketA?.memberCount).toBe(1);
    expect(bucketA?.dislikeCount).toBe(0);
    const persisted = bucketA!.centroid;
    for (let i = 0; i < keepA.embedding.length; i++) {
      expect(persisted[i]).toBeCloseTo(keepA.embedding[i] ?? 0, 6);
    }

    // B: pruned.
    const bRows = await db.select().from(schema.bucket).where(eq(schema.bucket.id, bId));
    expect(bRows).toHaveLength(0);

    // Recommendations: the stale [A,B] row is gone; the C/D merge was
    // re-derived as the only pending row.
    const pending = await db
      .select()
      .from(schema.bucketRecommendation)
      .where(eq(schema.bucketRecommendation.status, "pending"));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("merge");
    expect(pending[0]?.bucketIds).toEqual([cId, dId].sort((x, y) => x - y));

    // Refill bumped exactly once, chained to v1, with a note naming the
    // drifted buckets that changed the keep-anchor set.
    const active = await getActiveModelVersion(db, "refill");
    expect(active?.id).not.toBe(refillV1.id);
    expect(active?.parentId).toBe(refillV1.id);
    expect(active?.note).toBe(
      "bucket reconcile: membership repair changed the refill keep-anchor set " +
        `(buckets ${[aAssign.bucketId, bId].sort((x, y) => x - y).join(", ")})`,
    );
    expect(active?.config).toEqual(refillV1.config);
    const refillVersions = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.kind, "refill"));
    expect(refillVersions).toHaveLength(2);
  });

  it("a second run is a complete no-op — no second bump, no recommendation churn", async () => {
    await ensureActiveModelVersion(db, "refill");
    const t = await insertTrack({
      title: "Drifter",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    const assign = await assignTrack(db, t.id, { origin: "seed_track", spawnThreshold: 0.7 });
    // Manufacture drift without deleting the member.
    await db
      .update(schema.bucket)
      .set({ memberCount: 99 })
      .where(eq(schema.bucket.id, assign.bucketId));

    const first = await reconcileBuckets(db);
    expect(first.repaired).toBe(true);
    expect(first.refillVersionBumped).toBe(true);

    const activeAfterFirst = await getActiveModelVersion(db, "refill");
    const pendingAfterFirst = await db
      .select()
      .from(schema.bucketRecommendation)
      .where(eq(schema.bucketRecommendation.status, "pending"));

    const second = await reconcileBuckets(db);
    expect(second.repaired).toBe(false);
    expect(second.driftedBucketIds).toEqual([]);
    expect(second.staleRecommendationCount).toBe(0);
    expect(second.recommendationsRebuilt).toBe(false);
    expect(second.refillVersionBumped).toBe(false);

    const activeAfterSecond = await getActiveModelVersion(db, "refill");
    expect(activeAfterSecond?.id).toBe(activeAfterFirst?.id);
    const versions = await db.select().from(schema.modelVersion);
    expect(versions.filter((v) => v.kind === "refill")).toHaveLength(2);
    const pendingAfterSecond = await db
      .select()
      .from(schema.bucketRecommendation)
      .where(eq(schema.bucketRecommendation.status, "pending"));
    expect(pendingAfterSecond.map((r) => r.id)).toEqual(pendingAfterFirst.map((r) => r.id));
  });

  it("does not resurrect a dismissed recommendation when rebuilding", async () => {
    await ensureActiveModelVersion(db, "refill");
    // Near-twin buckets whose merge the user already dismissed.
    const twinCentroid = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 0.9 : 0.1));
    const cId = await seedConsistentBucket({
      name: "C",
      primaryGenre: "house",
      centroid: twinCentroid,
    });
    const dId = await seedConsistentBucket({
      name: "D",
      primaryGenre: "house",
      centroid: twinCentroid,
    });
    await db.insert(schema.bucketRecommendation).values({
      kind: "merge",
      bucketIds: [cId, dId].sort((x, y) => x - y),
      reason: { similarity: 1, threshold: 0.92 },
      status: "dismissed",
      resolvedAt: new Date(),
    });

    // Manufacture drift so the rebuild branch runs.
    await db.update(schema.bucket).set({ memberCount: 99 }).where(eq(schema.bucket.id, cId));

    const result = await reconcileBuckets(db);
    expect(result.repaired).toBe(true);
    expect(result.recommendationsRebuilt).toBe(true);

    const all = await db.select().from(schema.bucketRecommendation);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("dismissed");
  });

  it("repairs stale recommendations without minting a refill version when membership is untouched", async () => {
    // The merge-accept path deletes a bucket; `bucket_ids` is a plain int[]
    // with no FK, so a pending recommendation can reference a bucket that no
    // longer exists while every surviving bucket stays consistent. The sweep
    // must clean and re-derive recommendations WITHOUT bumping the refill
    // version — no membership changed, so the keep-anchor set is untouched.
    const refillV1 = await ensureActiveModelVersion(db, "refill");
    const twinCentroid = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 0.9 : 0.1));
    const cId = await seedConsistentBucket({
      name: "C",
      primaryGenre: "house",
      centroid: twinCentroid,
    });
    const dId = await seedConsistentBucket({
      name: "D",
      primaryGenre: "house",
      centroid: twinCentroid,
    });
    await db.insert(schema.bucketRecommendation).values({
      kind: "merge",
      bucketIds: [cId, 99999], // 99999 = a merged-away bucket
      reason: { similarity: 0.99, threshold: 0.92 },
      status: "pending",
    });

    const result = await reconcileBuckets(db);
    expect(result.repaired).toBe(true);
    expect(result.driftedBucketIds).toEqual([]);
    expect(result.staleRecommendationCount).toBe(1);
    expect(result.recommendationsRebuilt).toBe(true);
    expect(result.refillVersionBumped).toBe(false);

    // Version chain untouched.
    const active = await getActiveModelVersion(db, "refill");
    expect(active?.id).toBe(refillV1.id);
    const refillVersions = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.kind, "refill"));
    expect(refillVersions).toHaveLength(1);

    // The stale row is gone; the C/D merge was re-derived as pending.
    const pending = await db
      .select()
      .from(schema.bucketRecommendation)
      .where(eq(schema.bucketRecommendation.status, "pending"));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.bucketIds).toEqual([cId, dId].sort((x, y) => x - y));
  });

  it("skips the refill bump when no active refill version exists", async () => {
    const t = await insertTrack({
      title: "Driftless install",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    const assign = await assignTrack(db, t.id, { origin: "seed_track", spawnThreshold: 0.7 });
    await db
      .update(schema.bucket)
      .set({ memberCount: 42 })
      .where(eq(schema.bucket.id, assign.bucketId));

    const result = await reconcileBuckets(db);
    expect(result.repaired).toBe(true);
    expect(result.refillVersionBumped).toBe(false);
    const versions = await db.select().from(schema.modelVersion);
    expect(versions.filter((v) => v.kind === "refill")).toHaveLength(0);
  });

  it("is a no-op on a consistent database", async () => {
    const t = await insertTrack({
      title: "Healthy",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    await assignTrack(db, t.id, { origin: "seed_track", spawnThreshold: 0.7 });

    const result = await reconcileBuckets(db);
    expect(result.repaired).toBe(false);
    expect(result.driftedBucketIds).toEqual([]);
    expect(result.prunedBucketIds).toEqual([]);
    expect(result.staleRecommendationCount).toBe(0);
  });
});

describe("reconcileBuckets — LAB-36/73 refill config upgrade step", () => {
  it("upgrades a legacy {lambda}-only active config exactly once; re-run is a no-op", async () => {
    // Pre-LAB-36 install: the active refill version has no audioWeight. The
    // app_config knob (here deliberately non-default) supplies the value.
    const legacy = await bumpModelVersion(db, "refill", { lambda: 0.42 }, { note: "legacy" });
    await db.update(schema.appConfig).set({ audioWeight: 3 });

    const first = await reconcileBuckets(db);
    expect(first.repaired).toBe(false); // config upgrade is not a repair
    expect(first.refillVersionBumped).toBe(false);
    expect(first.refillConfigUpgraded).toBe(true);

    const active = await getActiveModelVersion(db, "refill");
    expect(active?.id).not.toBe(legacy.id);
    expect(active?.parentId).toBe(legacy.id);
    expect(active?.config).toEqual({
      lambda: 0.42,
      audioWeight: 3,
      genreGate: "slot-overlap",
      familiarityPenalty: 0.1,
      audioCoverageGate: true,
    });
    expect(active?.note).toBe(
      "refill config upgrade: slot-overlap gate + audio-weighted cosine + familiarity penalty + null-audio coverage gate",
    );

    const second = await reconcileBuckets(db);
    expect(second.refillConfigUpgraded).toBe(false);
    const refillVersions = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.kind, "refill"));
    expect(refillVersions).toHaveLength(2);
    const activeAfterSecond = await getActiveModelVersion(db, "refill");
    expect(activeAfterSecond?.id).toBe(active?.id);
  });

  it("installs the gate on a gate-less {lambda, audioWeight} config, preserving the frozen weight", async () => {
    // A Console audioWeight bump on a still-legacy active config mints
    // {lambda, audioWeight} WITHOUT a genreGate (the knob never invents one —
    // pinned by the params router tests). The upgrade must key on the missing
    // gate, not on audioWeight presence, or such an install would stay on the
    // 'exact' fallback forever. The frozen weight (4) must survive even when
    // app_config.audio_weight has drifted (3) — carry-forward, not re-read.
    const gateless = await bumpModelVersion(
      db,
      "refill",
      { lambda: 0.3, audioWeight: 4 },
      { note: "audioWeight update: 2.5 → 4" },
    );
    await db.update(schema.appConfig).set({ audioWeight: 3 });

    const result = await reconcileBuckets(db);
    expect(result.refillConfigUpgraded).toBe(true);
    const active = await getActiveModelVersion(db, "refill");
    expect(active?.parentId).toBe(gateless.id);
    expect(active?.config).toEqual({
      lambda: 0.3,
      audioWeight: 4,
      genreGate: "slot-overlap",
      familiarityPenalty: 0.1,
      audioCoverageGate: true,
    });

    const second = await reconcileBuckets(db);
    expect(second.refillConfigUpgraded).toBe(false);
  });

  it("never fires for a fresh bootstrap (its config already carries audioWeight) or with no active version", async () => {
    const bare = await reconcileBuckets(db);
    expect(bare.refillConfigUpgraded).toBe(false);

    const bootstrap = await ensureActiveModelVersion(db, "refill");
    expect((bootstrap.config as { audioWeight?: number }).audioWeight).toBeDefined();
    const result = await reconcileBuckets(db);
    expect(result.refillConfigUpgraded).toBe(false);
    const refillVersions = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.kind, "refill"));
    expect(refillVersions).toHaveLength(1);
  });

  it("composes with the membership-repair bump: repair (carry-forward) then upgrade, two rows, chained in order", async () => {
    const legacy = await bumpModelVersion(db, "refill", { lambda: 0.3 }, { note: "legacy" });
    const t = await insertTrack({
      title: "Drifter",
      audioFeatures: audio({ tempo: 130 }),
      genres: ["rock"],
    });
    const assign = await assignTrack(db, t.id, { origin: "seed_track", spawnThreshold: 0.7 });
    await db
      .update(schema.bucket)
      .set({ memberCount: 99 })
      .where(eq(schema.bucket.id, assign.bucketId));

    const result = await reconcileBuckets(db);
    expect(result.repaired).toBe(true);
    expect(result.refillVersionBumped).toBe(true);
    expect(result.refillConfigUpgraded).toBe(true);

    // Chain: legacy → repair bump (config carried forward UNCHANGED, still
    // legacy-shaped) → LAB-36 upgrade (new fields added). Separate rows,
    // separate notes.
    const active = await getActiveModelVersion(db, "refill");
    expect(active?.config).toEqual({
      lambda: 0.3,
      audioWeight: 2.5,
      genreGate: "slot-overlap",
      familiarityPenalty: 0.1,
      audioCoverageGate: true,
    });
    expect(active?.note).toBe(
      "refill config upgrade: slot-overlap gate + audio-weighted cosine + familiarity penalty + null-audio coverage gate",
    );
    const [repairBump] = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.id, active!.parentId!));
    expect(repairBump?.config).toEqual({ lambda: 0.3 });
    expect(repairBump?.note).toContain("bucket reconcile: membership repair");
    expect(repairBump?.parentId).toBe(legacy.id);
  });

  it("LAB-73 — backfills familiarityPenalty on a post-LAB-36 config that lacks only it", async () => {
    // A config that already carries audioWeight + genreGate (post-LAB-36) but
    // predates LAB-73 must still get the novelty-scaled familiarity penalty
    // installed — keyed on the missing field, exactly once.
    const preLab73 = await bumpModelVersion(
      db,
      "refill",
      { lambda: 0.3, audioWeight: 2.5, genreGate: "slot-overlap" },
      { note: "pre-LAB-73" },
    );
    await db.update(schema.appConfig).set({ novelty: 0.5 });

    const result = await reconcileBuckets(db);
    expect(result.refillConfigUpgraded).toBe(true);
    const active = await getActiveModelVersion(db, "refill");
    expect(active?.parentId).toBe(preLab73.id);
    expect(active?.config).toEqual({
      lambda: 0.3,
      audioWeight: 2.5,
      genreGate: "slot-overlap",
      familiarityPenalty: 0.1, // novelty 0.5 × 0.2
      audioCoverageGate: true,
    });

    const second = await reconcileBuckets(db);
    expect(second.refillConfigUpgraded).toBe(false);
  });
});

describe("reconcileBuckets — LAB-92 broad config upgrade step", () => {
  it("freezes the breakout-penalty knob onto a legacy broad config exactly once; re-run is a no-op", async () => {
    // Pre-LAB-92 install: the active broad version predates the knob. The
    // app_config knob (deliberately non-default) supplies the frozen value;
    // weights/bias/prior are carried forward unchanged.
    const legacy = await bumpModelVersion(
      db,
      "broad",
      { weights: null, bias: 0, trainedSampleCount: 0, prior: 0.5 },
      { note: "legacy broad" },
    );
    await db.update(schema.appConfig).set({ breakoutPenalty: 0.25 });

    const first = await reconcileBuckets(db);
    expect(first.repaired).toBe(false); // config upgrade is not a repair
    expect(first.broadConfigUpgraded).toBe(true);

    const active = await getActiveModelVersion(db, "broad");
    expect(active?.id).not.toBe(legacy.id);
    expect(active?.parentId).toBe(legacy.id);
    expect(active?.config).toEqual({
      weights: null,
      bias: 0,
      trainedSampleCount: 0,
      prior: 0.5,
      breakoutPenalty: 0.25,
    });
    expect(active?.note).toBe("broad config upgrade: breakout mainstream down-weight (LAB-92)");

    const second = await reconcileBuckets(db);
    expect(second.broadConfigUpgraded).toBe(false);
    const broadVersions = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.kind, "broad"));
    expect(broadVersions).toHaveLength(2);
  });

  it("never fires for a fresh bootstrap (its config already carries breakoutPenalty) or with no active broad version", async () => {
    const bare = await reconcileBuckets(db);
    expect(bare.broadConfigUpgraded).toBe(false);

    const bootstrap = await ensureActiveModelVersion(db, "broad");
    expect((bootstrap.config as { breakoutPenalty?: number }).breakoutPenalty).toBeDefined();
    const result = await reconcileBuckets(db);
    expect(result.broadConfigUpgraded).toBe(false);
    const broadVersions = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.kind, "broad"));
    expect(broadVersions).toHaveLength(1);
  });
});
