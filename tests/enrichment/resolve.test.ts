import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import * as schema from "@/db/schema";
import { resolveCandidate } from "@/lib/enrichment/resolve";
import type { RawCandidate } from "@/lib/ingestion/types";

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
  // Clean slate per test. Cascade clears track_source via FK.
  await db.execute(sql`TRUNCATE TABLE ${schema.trackSource} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
});

function spotifyCandidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    source: "spotify",
    sourceTrackId: "spotify:track:1",
    isrc: "USRC17607839",
    spotifyId: "spotify:track:1",
    title: "Reckoner",
    artist: "Radiohead",
    album: "In Rainbows",
    releaseYear: 2007,
    durationMs: 290_000,
    genres: [],
    rawPayload: { id: "spotify:track:1" },
    ...overrides,
  };
}

describe("enrichment resolve — idempotency", () => {
  it("running twice on the same candidate creates exactly one track + one track_source", async () => {
    const c = spotifyCandidate();

    const first = await resolveCandidate(db, c);
    expect(first.created).toBe(true);
    expect(first.matchedBy).toBe("inserted");

    const second = await resolveCandidate(db, c);
    expect(second.created).toBe(false);
    expect(second.matchedBy).toBe("isrc");
    expect(second.trackId).toBe(first.trackId);

    const tracks = await db.select().from(schema.track);
    expect(tracks).toHaveLength(1);
    const sources = await db.select().from(schema.trackSource);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.trackId).toBe(first.trackId);
  });

  it("merges a Last.fm sighting into the same track when fuzzy match crosses threshold", async () => {
    const sp = spotifyCandidate();
    const lf: RawCandidate = {
      source: "lastfm",
      sourceTrackId: "lastfm:radiohead::reckoner",
      isrc: null,
      spotifyId: null,
      title: "Reckoner",
      artist: "Radiohead",
      album: null,
      releaseYear: null,
      durationMs: null,
      genres: [],
      rawPayload: { name: "Reckoner" },
    };

    const a = await resolveCandidate(db, sp);
    const b = await resolveCandidate(db, lf);
    expect(b.trackId).toBe(a.trackId);
    expect(b.matchedBy).toBe("fuzzy");

    const tracks = await db.select().from(schema.track);
    expect(tracks).toHaveLength(1);
    const sources = await db.select().from(schema.trackSource);
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((s) => s.source))).toEqual(new Set(["spotify", "lastfm"]));
  });

  it("backfills nullable scalars on the existing row without overwriting non-nulls", async () => {
    const sparse: RawCandidate = {
      source: "lastfm",
      sourceTrackId: "lastfm:1",
      isrc: null,
      spotifyId: null,
      title: "Karma Police",
      artist: "Radiohead",
      album: null,
      releaseYear: null,
      durationMs: null,
      genres: [],
      rawPayload: {},
    };
    const rich: RawCandidate = {
      source: "spotify",
      sourceTrackId: "spotify:karma",
      isrc: "GBAYE9700022",
      spotifyId: "spotify:karma",
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      releaseYear: 1997,
      durationMs: 261_000,
      genres: [],
      rawPayload: {},
    };

    await resolveCandidate(db, sparse);
    const merged = await resolveCandidate(db, rich);

    const [row] = await db.select().from(schema.track);
    expect(row?.id).toBe(merged.trackId);
    expect(row?.isrc).toBe("GBAYE9700022");
    expect(row?.spotifyId).toBe("spotify:karma");
    expect(row?.album).toBe("OK Computer");
    expect(row?.releaseYear).toBe(1997);
    expect(row?.durationMs).toBe(261_000);
  });

  it("treats distinct ISRCs as distinct tracks even when titles fuzzy-match", async () => {
    const original = spotifyCandidate({
      isrc: "USRC17607839",
      sourceTrackId: "spotify:original",
      spotifyId: "spotify:original",
    });
    const remix = spotifyCandidate({
      isrc: "USRC22222222",
      sourceTrackId: "spotify:remix",
      spotifyId: "spotify:remix",
      title: "Reckoner",
      album: "In Rainbows (Special Edition)",
    });

    await resolveCandidate(db, original);
    const out = await resolveCandidate(db, remix);
    // Different ISRC + same artist/title is a different recording (remix,
    // re-release, alt master). Fuzzy must NOT merge them.
    expect(out.matchedBy).toBe("inserted");
    const tracks = await db.select().from(schema.track);
    expect(tracks).toHaveLength(2);
  });
});
