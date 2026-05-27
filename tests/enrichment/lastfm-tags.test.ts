import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { enrichGenresFromLastfm } from "@/lib/enrichment/lastfm-tags";
import type { Env } from "@/server/env";

/**
 * Last.fm tags genre enrichment — fills `genres` / `primary_genre` /
 * `embedding` for tracks via `track.getTopTags`. All Last.fm HTTP is
 * stubbed; behaviour around tag counts, the in-body API error envelope,
 * and idempotency is pinned here.
 */

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
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const env: Env = {
  DATABASE_URL: "postgres://localhost/test",
  ADMIN_PASSPHRASE: "x",
  ANTHROPIC_API_KEY: "",
  SPOTIFY_CLIENT_ID: "",
  SPOTIFY_CLIENT_SECRET: "",
  SPOTIFY_REDIRECT_URI: "http://localhost/cb",
  LASTFM_API_KEY: "key",
  VIBERATE_API_KEY: "",
  PORT: 3000,
  NODE_ENV: "test",
  CRON_DISABLED: "",
};

type Tag = { name: string; count: number | string };
type LastfmEnvelope = { toptags?: { tag?: Tag[] | Tag }; error?: number; message?: string };

function stubLastfm(byTrack: Record<string, LastfmEnvelope>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    if (!u.toString().includes("ws.audioscrobbler.com")) {
      return new Response("unexpected", { status: 404 });
    }
    const artist = u.searchParams.get("artist") ?? "";
    const title = u.searchParams.get("track") ?? "";
    const key = `${artist}::${title}`;
    const env = byTrack[key] ?? { toptags: { tag: [] } };
    return new Response(JSON.stringify(env), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function seedTrack(artist: string, title: string): Promise<number> {
  const [row] = await db
    .insert(schema.track)
    .values({
      title,
      artist,
      genres: [],
      audioFeatures: {
        tempo: 120,
        energy: 0.5,
        valence: 0.5,
        danceability: 0.5,
        acousticness: 0.5,
        instrumentalness: 0.5,
      },
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return row.id;
}

describe("enrichGenresFromLastfm", () => {
  it("filters by tag count, writes genres + primary_genre + embedding", async () => {
    stubLastfm({
      "Beach House::Levitation": {
        toptags: {
          tag: [
            { name: "dream pop", count: 100 },
            { name: "shoegaze", count: 80 },
            { name: "indie", count: 60 },
            // Below MIN_TAG_COUNT — must be dropped.
            { name: "favourite", count: 3 },
            { name: "seen live", count: 1 },
          ],
        },
      },
    });
    const id = await seedTrack("Beach House", "Levitation");

    const result = await enrichGenresFromLastfm(db, env, [id]);
    expect(result.updated).toBe(1);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual(["dream pop", "shoegaze", "indie"]);
    // dream-pop is the longest-matching slot keyword → wins primary.
    expect(row?.primaryGenre).toBe("dream-pop");
    expect(row?.embedding).toHaveLength(64);
  });

  it("is idempotent — a second run skips tracks that already have genres", async () => {
    stubLastfm({
      "Beach House::Levitation": {
        toptags: { tag: [{ name: "dream pop", count: 100 }] },
      },
    });
    const id = await seedTrack("Beach House", "Levitation");

    expect((await enrichGenresFromLastfm(db, env, [id])).updated).toBe(1);
    expect((await enrichGenresFromLastfm(db, env, [id])).updated).toBe(0);
  });

  it("degrades silently when Last.fm returns the in-body error envelope", async () => {
    stubLastfm({
      "Unknown Artist::Unknown Track": {
        error: 6,
        message: "Track not found",
      },
    });
    const id = await seedTrack("Unknown Artist", "Unknown Track");

    const result = await enrichGenresFromLastfm(db, env, [id]);
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    // Track still bucketable on audio alone — genres unchanged.
    expect(row?.genres).toEqual([]);
    expect(row?.primaryGenre).toBeNull();
  });

  it("no-ops without a Last.fm API key (and never calls fetch)", async () => {
    const mock = stubLastfm({
      "Beach House::Levitation": {
        toptags: { tag: [{ name: "dream pop", count: 100 }] },
      },
    });
    const id = await seedTrack("Beach House", "Levitation");

    const result = await enrichGenresFromLastfm(db, { ...env, LASTFM_API_KEY: "" }, [id]);
    expect(result.updated).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });

  it("handles single-tag responses (Last.fm returns object, not array)", async () => {
    stubLastfm({
      "Solo Artist::Only Tag": {
        // When a track has exactly one tag, Last.fm returns `tag` as an
        // object instead of an array. Our parser must accept both.
        toptags: { tag: { name: "jazz", count: 50 } },
      },
    });
    const id = await seedTrack("Solo Artist", "Only Tag");

    const result = await enrichGenresFromLastfm(db, env, [id]);
    expect(result.updated).toBe(1);
    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual(["jazz"]);
    expect(row?.primaryGenre).toBe("jazz");
  });
});
