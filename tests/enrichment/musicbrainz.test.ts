import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { enrichGenresFromMusicBrainz } from "@/lib/enrichment/musicbrainz";
import type { Env } from "@/server/env";

/**
 * MusicBrainz recording-level genre enrichment. MBID lookup chain:
 *   1. `track.mbid` already set → use it.
 *   2. Else call Last.fm `track.getInfo` and persist on success.
 *   3. Else mark processed and skip.
 *
 * All HTTP is stubbed. The module's MB rate-limiter is real but irrelevant
 * here — vitest doesn't fake timers for these tests; we just verify the
 * data flow.
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
  LASTFM_API_KEY: "lfm-key",
  MUSICBRAINZ_CONTACT_EMAIL: "test@example.com",
  DISCOGS_KEY: "",
  DISCOGS_SECRET: "",
  VIBERATE_API_KEY: "",
  VIBERATE_TRENDING_COUNTRY: "US",
  CHARTMETRIC_REFRESH_TOKEN: "",
  CHARTMETRIC_TRENDING_COUNTRY: "US",
  PORT: 3000,
  NODE_ENV: "test",
  CRON_DISABLED: "",
};

type StubMap = {
  lastfm?: Record<string, { mbid?: string | null; error?: number }>;
  mb?: Record<string, { genres?: { name: string }[]; tags?: { name: string }[] } | "not-found">;
};

/** Stub both Last.fm `track.getInfo` and MusicBrainz `/ws/2/recording/{mbid}`. */
function stubHttp(maps: StubMap): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.hostname === "ws.audioscrobbler.com") {
      const artist = u.searchParams.get("artist") ?? "";
      const entry = maps.lastfm?.[artist];
      if (!entry) return new Response(JSON.stringify({ track: { mbid: "" } }), { status: 200 });
      if (entry.error !== undefined) {
        return new Response(JSON.stringify({ error: entry.error }), { status: 200 });
      }
      return new Response(JSON.stringify({ track: entry.mbid ? { mbid: entry.mbid } : {} }), {
        status: 200,
      });
    }
    if (u.hostname === "musicbrainz.org") {
      const match = u.pathname.match(/\/ws\/2\/recording\/([^/?]+)/);
      const mbid = match?.[1] ?? "";
      const entry = maps.mb?.[mbid];
      if (!entry || entry === "not-found") {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(entry), { status: 200 });
    }
    return new Response("unexpected", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function seedTrack(opts: {
  artist: string;
  title: string;
  mbid?: string | null;
  genres?: string[];
}): Promise<number> {
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: opts.artist,
      mbid: opts.mbid ?? null,
      genres: opts.genres ?? [],
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

describe("enrichGenresFromMusicBrainz", () => {
  it("uses an already-cached track.mbid — no Last.fm call", async () => {
    const mock = stubHttp({
      mb: {
        "abc-mbid": { genres: [{ name: "indie rock" }], tags: [{ name: "melancholy" }] },
      },
    });
    const id = await seedTrack({ artist: "The Shins", title: "New Slang", mbid: "abc-mbid" });

    const result = await enrichGenresFromMusicBrainz(db, env, [id]);
    expect(result.updated).toBe(1);

    // Only the MB request must have happened.
    const calls = mock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("musicbrainz.org"))).toBe(true);
    expect(calls.some((u) => u.includes("ws.audioscrobbler.com"))).toBe(false);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual(["indie rock", "melancholy"]);
    expect(row?.mbid).toBe("abc-mbid");
    expect(row?.genreSourcesProcessed).toEqual(["musicbrainz"]);
  });

  it("resolves MBID via Last.fm track.getInfo and persists it on the row", async () => {
    stubHttp({
      lastfm: { "The Shins": { mbid: "resolved-mbid" } },
      mb: { "resolved-mbid": { genres: [{ name: "indie pop" }] } },
    });
    const id = await seedTrack({ artist: "The Shins", title: "New Slang", mbid: null });

    const result = await enrichGenresFromMusicBrainz(db, env, [id]);
    expect(result.updated).toBe(1);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.mbid).toBe("resolved-mbid");
    expect(row?.genres).toEqual(["indie pop"]);
  });

  it("marks processed and skips when Last.fm has no MBID for the track", async () => {
    stubHttp({
      lastfm: { "Obscure Artist": { mbid: null } },
    });
    const id = await seedTrack({ artist: "Obscure Artist", title: "Obscure Track" });

    const result = await enrichGenresFromMusicBrainz(db, env, [id]);
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.mbid).toBeNull();
    expect(row?.genres).toEqual([]);
    expect(row?.genreSourcesProcessed).toEqual(["musicbrainz"]);
  });

  it("marks processed when MB returns 404 for the recording", async () => {
    stubHttp({
      mb: { "ghost-mbid": "not-found" },
    });
    const id = await seedTrack({ artist: "Artist", title: "Track", mbid: "ghost-mbid" });

    await enrichGenresFromMusicBrainz(db, env, [id]);
    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genreSourcesProcessed).toEqual(["musicbrainz"]);
    expect(row?.genres).toEqual([]);
  });

  it("merges additively with pre-existing genres", async () => {
    stubHttp({
      mb: { "mbid-1": { genres: [{ name: "Shoegaze" }] } },
    });
    const id = await seedTrack({
      artist: "Beach House",
      title: "Levitation",
      mbid: "mbid-1",
      genres: ["dream pop", "indie"],
    });

    await enrichGenresFromMusicBrainz(db, env, [id]);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual(["dream pop", "indie", "Shoegaze"]);
  });

  it("idempotent — does not re-process tracks already flagged", async () => {
    const mock = stubHttp({
      mb: { "mbid-1": { genres: [{ name: "rock" }] } },
    });
    const id = await seedTrack({ artist: "X", title: "Y", mbid: "mbid-1" });

    await enrichGenresFromMusicBrainz(db, env, [id]);
    await enrichGenresFromMusicBrainz(db, env, [id]);

    // Only the first call hit MB.
    const mbCalls = mock.mock.calls.filter((c) => String(c[0]).includes("musicbrainz.org"));
    expect(mbCalls).toHaveLength(1);
  });

  it("no-ops without MUSICBRAINZ_CONTACT_EMAIL", async () => {
    const mock = stubHttp({});
    const id = await seedTrack({ artist: "X", title: "Y", mbid: "mbid-1" });

    const result = await enrichGenresFromMusicBrainz(
      db,
      { ...env, MUSICBRAINZ_CONTACT_EMAIL: "" },
      [id],
    );
    expect(result.updated).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });
});
