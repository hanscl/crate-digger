import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { enrichGenresFromArtists } from "@/lib/enrichment/spotify-metadata";
import { _resetSpotifyTokenCache } from "@/lib/ingestion/spotify";
import type { Env } from "@/server/env";

/**
 * Spotify genre enrichment — fills `genres` / `primary_genre` / `embedding`
 * for Spotify-sourced tracks via individual `/artists/{id}` lookups. All
 * Spotify HTTP is stubbed.
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
  await db.execute(sql`TRUNCATE TABLE ${schema.trackSource} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  _resetSpotifyTokenCache();
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
  SPOTIFY_CLIENT_ID: "client",
  SPOTIFY_CLIENT_SECRET: "secret",
  SPOTIFY_REDIRECT_URI: "http://localhost/cb",
  LASTFM_API_KEY: "",
  VIBERATE_API_KEY: "",
  PORT: 3000,
  NODE_ENV: "test",
  CRON_DISABLED: "",
};

const ARTIST_GENRES: Record<string, string[]> = {
  art1: ["indie rock", "shoegaze"],
  art2: ["dream pop"],
};

/** Stubs the Spotify token endpoint + the single-artist endpoint. */
function stubSpotify(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("https://accounts.spotify.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
      });
    }
    const artistMatch = /\/v1\/artists\/([^/?]+)/.exec(url);
    if (artistMatch) {
      const id = artistMatch[1] ?? "";
      return new Response(JSON.stringify({ id, name: id, genres: ARTIST_GENRES[id] ?? [] }), {
        status: 200,
      });
    }
    return new Response("unexpected", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function seedSpotifyTrack(spotifyId: string, artistIds: string[]): Promise<number> {
  const [row] = await db
    .insert(schema.track)
    .values({
      title: "Some Track",
      artist: "Some Artist",
      spotifyId,
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
  await db.insert(schema.trackSource).values({
    trackId: row.id,
    source: "spotify",
    sourceTrackId: spotifyId,
    rawPayload: {
      id: spotifyId,
      name: "Some Track",
      artists: artistIds.map((id) => ({ id, name: id })),
      album: { id: "al1", name: "Album" },
    },
  });
  return row.id;
}

describe("enrichGenresFromArtists", () => {
  it("unions artist genres into the track and rebuilds primary_genre + embedding", async () => {
    const mock = stubSpotify();
    const id = await seedSpotifyTrack("sp1", ["art1", "art2"]);

    const result = await enrichGenresFromArtists(db, env, [id]);
    expect(result.updated).toBe(1);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(new Set(row?.genres)).toEqual(new Set(["indie rock", "shoegaze", "dream pop"]));
    expect(row?.primaryGenre).toBe("dream-pop");
    expect(row?.embedding).toHaveLength(64);

    // Genre enrichment must never call the retired Spotify /audio-features.
    for (const call of mock.mock.calls) {
      expect(String(call[0])).not.toContain("/audio-features");
    }
  });

  it("is idempotent — a second run skips tracks that already have genres", async () => {
    stubSpotify();
    const id = await seedSpotifyTrack("sp1", ["art1"]);

    expect((await enrichGenresFromArtists(db, env, [id])).updated).toBe(1);
    expect((await enrichGenresFromArtists(db, env, [id])).updated).toBe(0);
  });

  it("caches each artist lookup across tracks that share an artist", async () => {
    const mock = stubSpotify();
    const a = await seedSpotifyTrack("sp1", ["art1"]);
    const b = await seedSpotifyTrack("sp2", ["art1"]);

    await enrichGenresFromArtists(db, env, [a, b]);

    const artistCalls = mock.mock.calls.filter((c) => String(c[0]).includes("/v1/artists/art1"));
    expect(artistCalls).toHaveLength(1);
  });

  it("no-ops without Spotify credentials", async () => {
    const mock = stubSpotify();
    const id = await seedSpotifyTrack("sp1", ["art1"]);

    const result = await enrichGenresFromArtists(
      db,
      { ...env, SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "" },
      [id],
    );
    expect(result.updated).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });
});
