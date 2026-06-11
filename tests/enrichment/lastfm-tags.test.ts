import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { enrichGenresFromLastfm, primaryArtist } from "@/lib/enrichment/lastfm-tags";
import type { Env } from "@/server/env";

/**
 * Last.fm tags genre enrichment — fills `genres` / `primary_genre` /
 * `embedding` via `artist.getTopTags`. We use artist-level (not
 * track-level) tags because `track.getTopTags` returns empty across the
 * board on the live API as of mid-2026; artist-level still serves rich
 * popularity-weighted clouds. All Last.fm HTTP is stubbed.
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
  MUSICBRAINZ_CONTACT_EMAIL: "",
  DISCOGS_KEY: "",
  DISCOGS_SECRET: "",
  VIBERATE_API_KEY: "",
  CHARTMETRIC_REFRESH_TOKEN: "",
  CHARTMETRIC_TIKTOK_COUNTRY: "US",
  SOUNDCHARTS_APP_ID: "",
  SOUNDCHARTS_API_KEY: "",
  SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-us",
  PORT: 3000,
  NODE_ENV: "test",
  CRON_DISABLED: "",
};

type Tag = { name: string; count: number | string };
type LastfmEnvelope = { toptags?: { tag?: Tag[] | Tag }; error?: number; message?: string };

function stubLastfm(byArtist: Record<string, LastfmEnvelope>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    if (!u.toString().includes("ws.audioscrobbler.com")) {
      return new Response("unexpected", { status: 404 });
    }
    const artist = u.searchParams.get("artist") ?? "";
    const env = byArtist[artist] ?? { toptags: { tag: [] } };
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

describe("primaryArtist", () => {
  it("returns the single artist unchanged", () => {
    expect(primaryArtist("Beach House")).toBe("Beach House");
  });
  it("splits Spotify's comma-joined multi-artist string", () => {
    expect(primaryArtist("The Shins, James Mercer")).toBe("The Shins");
  });
  it("returns null on whitespace-only input", () => {
    expect(primaryArtist("   ")).toBe(null);
    expect(primaryArtist("")).toBe(null);
  });
  it("trims surrounding whitespace", () => {
    expect(primaryArtist("  Beach House  ")).toBe("Beach House");
  });
});

describe("enrichGenresFromLastfm", () => {
  it("filters by tag count, writes genres + primary_genre + embedding", async () => {
    stubLastfm({
      "Beach House": {
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

  it("is idempotent — a second run skips tracks Last.fm has already processed", async () => {
    const mock = stubLastfm({
      "Beach House": {
        toptags: { tag: [{ name: "dream pop", count: 100 }] },
      },
    });
    const id = await seedTrack("Beach House", "Levitation");

    expect((await enrichGenresFromLastfm(db, env, [id])).updated).toBe(1);
    expect((await enrichGenresFromLastfm(db, env, [id])).updated).toBe(0);
    // Second call must not have re-hit Last.fm — the per-source guard
    // short-circuits before any fetch.
    expect(mock).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genreSourcesProcessed).toEqual(["lastfm"]);
  });

  it("flags processed even when Last.fm returns no tags (so we don't retry)", async () => {
    stubLastfm({
      "Empty Artist": { toptags: { tag: [] } },
    });
    const id = await seedTrack("Empty Artist", "Some Track");

    const result = await enrichGenresFromLastfm(db, env, [id]);
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual([]);
    expect(row?.genreSourcesProcessed).toEqual(["lastfm"]);
  });

  it("does NOT flag processed when the Last.fm request hard-fails (leaves it for retry)", async () => {
    // Non-OK HTTP is a transient infra failure, not a real "no tags" answer.
    // fetchWithRetry resolves it to null → the row must stay unprocessed so a
    // later run retries, rather than silencing the artist permanently.
    const mock = vi.fn(async () => new Response("upstream error", { status: 503 }));
    vi.stubGlobal("fetch", mock);
    const id = await seedTrack("Beach House", "Levitation");

    const result = await enrichGenresFromLastfm(db, env, [id]);
    expect(result.updated).toBe(0);
    expect(mock).toHaveBeenCalled();

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual([]);
    // The whole point: 'lastfm' is NOT appended, so the track is retried.
    expect(row?.genreSourcesProcessed).toEqual([]);
  });

  it("merges additively with pre-existing genres (case-insensitive dedupe)", async () => {
    stubLastfm({
      "Beach House": {
        toptags: {
          tag: [
            { name: "Dream Pop", count: 100 },
            { name: "shoegaze", count: 80 },
          ],
        },
      },
    });
    const id = await seedTrack("Beach House", "Levitation");
    // Pre-seed a genre as if MB or Discogs had run first.
    await db
      .update(schema.track)
      .set({ genres: ["dream pop", "indie"] })
      .where(eq(schema.track.id, id));

    await enrichGenresFromLastfm(db, env, [id]);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    // Existing "dream pop" wins on casing over Last.fm's "Dream Pop";
    // "shoegaze" is new and appended.
    expect(row?.genres).toEqual(["dream pop", "indie", "shoegaze"]);
  });

  it("skips Last.fm entirely for Various Artists but flags the row processed", async () => {
    const mock = stubLastfm({});
    const id = await seedTrack("Various Artists", "Compilation Track");

    const result = await enrichGenresFromLastfm(db, env, [id]);
    expect(result.updated).toBe(0);
    expect(mock).not.toHaveBeenCalled();

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual([]);
    expect(row?.genreSourcesProcessed).toEqual(["lastfm"]);
  });

  it("caches per-artist — multiple tracks by one artist = one Last.fm call", async () => {
    const mock = stubLastfm({
      "Beach House": {
        toptags: { tag: [{ name: "dream pop", count: 100 }] },
      },
    });
    const a = await seedTrack("Beach House", "Levitation");
    const b = await seedTrack("Beach House", "Space Song");
    const c = await seedTrack("Beach House", "Myth");

    const result = await enrichGenresFromLastfm(db, env, [a, b, c]);
    expect(result.updated).toBe(3);

    const artistCalls = mock.mock.calls.filter((call) =>
      String(call[0]).includes("artist=Beach+House"),
    );
    expect(artistCalls).toHaveLength(1);
  });

  it("splits Spotify multi-artist join on the way out to Last.fm", async () => {
    const mock = stubLastfm({
      "The Shins": {
        toptags: {
          tag: [
            { name: "indie", count: 100 },
            { name: "indie rock", count: 83 },
          ],
        },
      },
    });
    // Spotify joins multi-artist credits as "Artist A, Artist B".
    const id = await seedTrack("The Shins, James Mercer", "Simple Song");

    const result = await enrichGenresFromLastfm(db, env, [id]);
    expect(result.updated).toBe(1);

    // The Last.fm call must use just the primary, not the joined string.
    const calls = mock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("artist=The+Shins") && !u.includes("Mercer"))).toBe(true);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual(["indie", "indie rock"]);
  });

  it("degrades silently when Last.fm returns the in-body error envelope", async () => {
    stubLastfm({
      "Unknown Artist": {
        error: 6,
        message: "Artist not found",
      },
    });
    const id = await seedTrack("Unknown Artist", "Unknown Track");

    const result = await enrichGenresFromLastfm(db, env, [id]);
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    // Track still bucketable on audio alone — genres unchanged.
    expect(row?.genres).toEqual([]);
    expect(row?.primaryGenre).toBeNull();
    // Flagged processed so we don't keep hammering Last.fm for an unknown artist.
    expect(row?.genreSourcesProcessed).toEqual(["lastfm"]);
  });

  it("no-ops without a Last.fm API key (and never calls fetch)", async () => {
    const mock = stubLastfm({
      "Beach House": {
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
      "Solo Artist": {
        // When an artist has exactly one tag at the top, Last.fm returns
        // `tag` as an object instead of an array. Our parser must accept both.
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
