import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { CandidatePoolEntry } from "@/db/schema";
import { ensureActiveModelVersion } from "@/lib/ranking/version";
import { logSurfaceEvents } from "@/lib/surfacing/log";

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
  await db.execute(sql`TRUNCATE TABLE ${schema.rating} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.surfaceEvent} RESTART IDENTITY CASCADE`);
  await db.execute(
    sql`UPDATE ${schema.appConfig} SET active_refill_version_id = NULL, active_broad_version_id = NULL`,
  );
  await db.execute(sql`TRUNCATE TABLE ${schema.modelVersion} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
});

async function insertTrackId(title: string): Promise<number> {
  const [row] = await db
    .insert(schema.track)
    .values({ title, artist: "x", genres: ["rock"] })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return row.id;
}

describe("logSurfaceEvents — eval-substrate guard (Constraint #2)", () => {
  it("persists candidate_pool with one entry per scored candidate, regardless of winner count", async () => {
    // The single most important contract in Phase 4. Direct test on the
    // log function: pass a 5-entry pool with 1 winner; assert all 5 are
    // persisted in candidate_pool with their original sub-scores.
    const trackIds = [];
    for (let i = 0; i < 5; i++) trackIds.push(await insertTrackId(`T${i}`));
    const broadVer = await ensureActiveModelVersion(db, "broad");

    const pool = trackIds.map((id, i) => ({
      candidate: { trackId: id, embedding: [0.1 * i, 0.2 * i] },
      score: 0.5 - i * 0.05,
      subScores: { logit: 0.1 * i, prior: 0.5 } as Record<string, number>,
      rankerKind: "broad" as const,
    }));
    const winner = pool[2]!;

    const events = await logSurfaceEvents(db, {
      pool,
      winners: [winner],
      modelVersionId: broadVer.id,
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.trackId).toBe(winner.candidate.trackId);
    expect(event.winnerScore).toBeCloseTo(winner.score, 9);
    expect(event.candidatePool).toHaveLength(5);

    const winnerEntries = event.candidatePool.filter((p: CandidatePoolEntry) => p.surfaced);
    expect(winnerEntries).toHaveLength(1);
    expect(winnerEntries[0]?.trackId).toBe(winner.candidate.trackId);
    // Sub-scores survive the round-trip — counterfactual replay reads them.
    for (let i = 0; i < pool.length; i++) {
      const entry = event.candidatePool.find(
        (p: CandidatePoolEntry) => p.trackId === pool[i]?.candidate.trackId,
      );
      expect(entry?.score).toBeCloseTo(pool[i]?.score ?? 0, 9);
      expect(entry?.subScores?.logit).toBeCloseTo(pool[i]?.subScores.logit ?? 0, 9);
    }
  });

  it("returns [] without inserting when winners is empty", async () => {
    const id = await insertTrackId("solo");
    const broadVer = await ensureActiveModelVersion(db, "broad");
    const pool = [
      {
        candidate: { trackId: id, embedding: [0] },
        score: 0,
        subScores: {} as Record<string, number>,
        rankerKind: "broad" as const,
      },
    ];

    const events = await logSurfaceEvents(db, {
      pool,
      winners: [],
      modelVersionId: broadVer.id,
    });
    expect(events).toHaveLength(0);
    const persisted = await db.select().from(schema.surfaceEvent);
    expect(persisted).toHaveLength(0);
  });
});
