import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { buildEmbedding } from "@/lib/embedding";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import { retrainBroad } from "@/lib/feedback/retrain";
import { ensureActiveModelVersion, getActiveModelVersion } from "@/lib/ranking/version";
import { isBroadConfig } from "@/lib/ranking/types";

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
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
});

function mkAudio(o: Partial<schema.AudioFeatures> = {}): schema.AudioFeatures {
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

async function seedTrack(opts: {
  title: string;
  audioFeatures: schema.AudioFeatures;
  genres: string[];
}): Promise<number> {
  const embedding = buildEmbedding({
    audioFeatures: opts.audioFeatures,
    genres: opts.genres,
  });
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: "x",
      audioFeatures: opts.audioFeatures,
      genres: opts.genres,
      embedding,
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return row.id;
}

describe("retrainBroad", () => {
  it("skips bumping the version when there are no labeled samples", async () => {
    const before = await ensureActiveModelVersion(db, "broad");
    const result = await retrainBroad(db);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("no_samples");
    expect(result.modelVersion).toBeNull();
    const after = await getActiveModelVersion(db, "broad");
    expect(after?.id).toBe(before.id);
  });

  it("skips bumping when only one class is represented", async () => {
    // Only keeps, no dislikes — a logistic classifier has no decision boundary.
    // We don't pollute the version chain with a duplicate of bootstrap.
    const t = await seedTrack({
      title: "Keep-only",
      audioFeatures: mkAudio({ energy: 0.8 }),
      genres: ["rock"],
    });
    await ingestRating(db, { trackId: t, decision: "keep" });
    const before = await ensureActiveModelVersion(db, "broad");
    const result = await retrainBroad(db);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("single_class");
    const after = await getActiveModelVersion(db, "broad");
    expect(after?.id).toBe(before.id);
  });

  it("trains and bumps a new broad version on balanced keep+dislike data", async () => {
    // Two well-separated classes in the embedding's audio dims. After
    // retraining the active broad version should have weights set, and the
    // version chain should have grown by one row past the bootstrap.
    for (let i = 0; i < 5; i++) {
      const k = await seedTrack({
        title: `Keep-${i}`,
        audioFeatures: mkAudio({ energy: 0.85 + i * 0.02, valence: 0.8 }),
        genres: ["rock"],
      });
      await ingestRating(db, { trackId: k, decision: "keep" });
      const d = await seedTrack({
        title: `Dis-${i}`,
        audioFeatures: mkAudio({ energy: 0.1 + i * 0.02, valence: 0.1 }),
        genres: ["rock"],
      });
      await ingestRating(db, { trackId: d, decision: "dislike" });
    }
    const bootstrap = await ensureActiveModelVersion(db, "broad");

    const result = await retrainBroad(db, { iterations: 200 });
    expect(result.skipped).toBe(false);
    expect(result.modelVersion).not.toBeNull();
    expect(result.sampleCount).toBe(10);
    expect(isBroadConfig(result.modelVersion!.config)).toBe(true);
    const cfg = result.modelVersion!.config as schema.AppConfig & {
      weights: number[] | null;
      bias: number;
      trainedSampleCount: number;
    };
    expect(cfg.weights).not.toBeNull();
    expect(cfg.trainedSampleCount).toBe(10);

    const active = await getActiveModelVersion(db, "broad");
    expect(active?.id).toBe(result.modelVersion!.id);
    expect(active?.parentId).toBe(bootstrap.id);
  });
});
