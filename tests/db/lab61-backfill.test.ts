import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";

/**
 * Migration-replay harness for the LAB-61 backfill (0010). Phase one
 * migrates a copy of `migrations/` truncated to 0009 (the pre-LAB-61
 * schema, no `origin` column), seeds legacy state with raw SQL, then phase
 * two migrates the REAL folder — drizzle applies only 0010 — and asserts
 * the backfill's mapping and cleanup against that state.
 */

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const PROVISION_TIMEOUT = 120_000;
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");
const LAB61_JOURNAL_IDX = 10;

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
}, PROVISION_TIMEOUT);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

/** Copy `migrations/` into a tmp dir with the journal truncated below `idx`. */
function migrationsTruncatedBelow(idx: number): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lab61-migrations-"));
  fs.cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
  const journalPath = path.join(tmp, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((e) => e.idx < idx);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return tmp;
}

const ZERO_VECTOR = `[${Array.from({ length: 64 }, () => 0).join(",")}]`;
const EMPTY_STATS = JSON.stringify({
  count: 0,
  mean: { tempo: 0, energy: 0, valence: 0, danceability: 0, acousticness: 0, instrumentalness: 0 },
  m2: { tempo: 0, energy: 0, valence: 0, danceability: 0, acousticness: 0, instrumentalness: 0 },
});

async function insertLegacyTrack(title: string): Promise<number> {
  const rows = await client.unsafe(
    `INSERT INTO track (title, artist) VALUES ($1, 'Legacy Artist') RETURNING id`,
    [title],
  );
  return Number(rows[0]!.id);
}

describe("LAB-61 backfill (migration 0010)", () => {
  it("maps keep→discovery_keep / no-rating→seed_track and deletes non-keep-rated memberships, keeping ratings", async () => {
    // Phase one: the pre-LAB-61 schema (0000–0009) — bucket_member has no
    // origin column yet.
    const truncated = migrationsTruncatedBelow(LAB61_JOURNAL_IDX);
    await migrate(db, { migrationsFolder: truncated });
    const cols = await client.unsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'bucket_member' AND column_name = 'origin'`,
    );
    expect(cols).toHaveLength(0);

    // Legacy state: one bucket holding the full pre-LAB-52 mix — a
    // no-rating seed, a kept member, a dislike-no-keep member, a defer-only
    // member, and a kept-then-disliked member.
    const tSeed = await insertLegacyTrack("seed (no rating)");
    const tKeep = await insertLegacyTrack("kept");
    const tDislike = await insertLegacyTrack("dislike only");
    const tDefer = await insertLegacyTrack("defer only");
    const tKeepDislike = await insertLegacyTrack("kept then disliked");

    const bucketRows = await client.unsafe(
      `INSERT INTO bucket (name, centroid, feature_stats, member_count)
       VALUES ('legacy', $1, $2, 5) RETURNING id`,
      [ZERO_VECTOR, EMPTY_STATS],
    );
    const bucketId = Number(bucketRows[0]!.id);
    for (const trackId of [tSeed, tKeep, tDislike, tDefer, tKeepDislike]) {
      await client.unsafe(
        `INSERT INTO bucket_member (bucket_id, track_id, similarity_at_join) VALUES ($1, $2, 1)`,
        [bucketId, trackId],
      );
    }

    const versionRows = await client.unsafe(
      `INSERT INTO model_version (kind, config) VALUES ('broad', '{}') RETURNING id`,
    );
    const versionId = Number(versionRows[0]!.id);
    const legacyRatings: [number, string][] = [
      [tKeep, "keep"],
      [tDislike, "dislike"],
      [tDefer, "defer"],
      [tKeepDislike, "keep"],
      [tKeepDislike, "dislike"],
    ];
    for (const [trackId, decision] of legacyRatings) {
      await client.unsafe(
        `INSERT INTO rating (track_id, decision, model_version_id) VALUES ($1, $2, $3)`,
        [trackId, decision, versionId],
      );
    }

    // Phase two: the real folder — drizzle applies only 0010.
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    const members = await client.unsafe(
      `SELECT track_id, origin FROM bucket_member ORDER BY track_id`,
    );
    const originByTrack = new Map(members.map((m) => [Number(m.track_id), m.origin as string]));
    // Rated-but-never-kept memberships are gone…
    expect(originByTrack.has(tDislike)).toBe(false);
    expect(originByTrack.has(tDefer)).toBe(false);
    // …kept members (even with a later dislike) are discovery keeps…
    expect(originByTrack.get(tKeep)).toBe("discovery_keep");
    expect(originByTrack.get(tKeepDislike)).toBe("discovery_keep");
    // …and the never-rated member is a (generic) seed.
    expect(originByTrack.get(tSeed)).toBe("seed_track");
    expect(members).toHaveLength(3);

    // The cleanup deletes MEMBERSHIPS only — every rating row survives
    // (Constraints #2/#3: never synthesize or destroy eval-substrate data).
    const ratings = await client.unsafe(`SELECT track_id, decision FROM rating`);
    expect(ratings).toHaveLength(legacyRatings.length);

    // The column lands NOT NULL once the backfill has run.
    const originCol = await client.unsafe(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'bucket_member' AND column_name = 'origin'`,
    );
    expect(originCol[0]?.is_nullable).toBe("NO");
  });

  it("is a no-op on a fresh database (full chain from zero)", async () => {
    await client.unsafe(`CREATE DATABASE lab61_fresh`);
    const freshUri = container.getConnectionUri().replace(/\/[^/]+$/, "/lab61_fresh");
    const freshClient = postgres(freshUri, { max: 1, prepare: false, onnotice: () => undefined });
    try {
      await freshClient.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
      const freshDb = drizzle(freshClient, { schema });
      await migrate(freshDb, { migrationsFolder: MIGRATIONS_DIR });

      const members = await freshClient.unsafe(`SELECT * FROM bucket_member`);
      expect(members).toHaveLength(0);
      const originCol = await freshClient.unsafe(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'bucket_member' AND column_name = 'origin'`,
      );
      expect(originCol[0]?.is_nullable).toBe("NO");
    } finally {
      await freshClient.end();
    }
  });
});
