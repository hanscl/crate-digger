import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { enrichGenresFromDiscogs } from "@/lib/enrichment/discogs";
import type { Env } from "@/server/env";

/**
 * Discogs genre + style enrichment. Master-first lookup falls back to
 * release. Both search and detail responses are stubbed.
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
  LASTFM_API_KEY: "",
  MUSICBRAINZ_CONTACT_EMAIL: "",
  DISCOGS_KEY: "key",
  DISCOGS_SECRET: "secret",
  VIBERATE_API_KEY: "",
  VIBERATE_TRENDING_COUNTRY: "US",
  CHARTMETRIC_REFRESH_TOKEN: "",
  CHARTMETRIC_TIKTOK_COUNTRY: "US",
  SOUNDCHARTS_APP_ID: "",
  SOUNDCHARTS_API_KEY: "",
  SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-us",
  PORT: 3000,
  NODE_ENV: "test",
  CRON_DISABLED: "",
};

type StubFixture = {
  masterSearch?: { id: number } | null;
  releaseSearch?: { id: number } | null;
  masters?: Record<number, { genres?: string[]; styles?: string[] }>;
  releases?: Record<number, { genres?: string[]; styles?: string[] }>;
};

function stubDiscogs(fixture: StubFixture): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.hostname !== "api.discogs.com") {
      return new Response("unexpected", { status: 404 });
    }
    if (u.pathname === "/database/search") {
      const type = u.searchParams.get("type");
      const hit = type === "master" ? fixture.masterSearch : fixture.releaseSearch;
      return new Response(JSON.stringify({ results: hit ? [{ id: hit.id, type }] : [] }), {
        status: 200,
      });
    }
    const masterMatch = u.pathname.match(/^\/masters\/(\d+)$/);
    if (masterMatch) {
      const id = Number.parseInt(masterMatch[1] ?? "", 10);
      const entry = fixture.masters?.[id];
      if (!entry) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(entry), { status: 200 });
    }
    const releaseMatch = u.pathname.match(/^\/releases\/(\d+)$/);
    if (releaseMatch) {
      const id = Number.parseInt(releaseMatch[1] ?? "", 10);
      const entry = fixture.releases?.[id];
      if (!entry) return new Response("not found", { status: 404 });
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
  genres?: string[];
}): Promise<number> {
  const [row] = await db
    .insert(schema.track)
    .values({
      title: opts.title,
      artist: opts.artist,
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

describe("enrichGenresFromDiscogs", () => {
  it("master-hit happy path — merges genres and styles", async () => {
    stubDiscogs({
      masterSearch: { id: 42 },
      masters: {
        42: { genres: ["Electronic"], styles: ["Synth-pop", "Indietronica"] },
      },
    });
    const id = await seedTrack({ artist: "Beach House", title: "Levitation" });

    const result = await enrichGenresFromDiscogs(db, env, [id]);
    expect(result.updated).toBe(1);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual(["Electronic", "Synth-pop", "Indietronica"]);
    expect(row?.genreSourcesProcessed).toEqual(["discogs"]);
  });

  it("falls back to release lookup when master search has no hit", async () => {
    const mock = stubDiscogs({
      masterSearch: null,
      releaseSearch: { id: 100 },
      releases: {
        100: { genres: ["Rock"], styles: ["Indie Rock"] },
      },
    });
    const id = await seedTrack({ artist: "The Shins", title: "New Slang" });

    const result = await enrichGenresFromDiscogs(db, env, [id]);
    expect(result.updated).toBe(1);

    const calls = mock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("type=master"))).toBe(true);
    expect(calls.some((u) => u.includes("type=release"))).toBe(true);
    expect(calls.some((u) => u.includes("/releases/100"))).toBe(true);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual(["Rock", "Indie Rock"]);
  });

  it("marks processed and skips when both searches miss", async () => {
    stubDiscogs({ masterSearch: null, releaseSearch: null });
    const id = await seedTrack({ artist: "Nobody", title: "Nothing" });

    const result = await enrichGenresFromDiscogs(db, env, [id]);
    expect(result.updated).toBe(0);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genres).toEqual([]);
    expect(row?.genreSourcesProcessed).toEqual(["discogs"]);
  });

  it("merges additively with pre-existing genres (case-insensitive dedupe)", async () => {
    stubDiscogs({
      masterSearch: { id: 5 },
      masters: { 5: { genres: ["Electronic"], styles: ["dream pop"] } },
    });
    const id = await seedTrack({
      artist: "Beach House",
      title: "Levitation",
      genres: ["Dream Pop", "indie"],
    });

    await enrichGenresFromDiscogs(db, env, [id]);

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    // "dream pop" from Discogs collides case-insensitively with the existing
    // "Dream Pop"; only one is kept (first casing wins).
    expect(row?.genres).toEqual(["Dream Pop", "indie", "Electronic"]);
  });

  it("sends consumer key/secret as URL params and a User-Agent header", async () => {
    const mock = stubDiscogs({
      masterSearch: { id: 1 },
      masters: { 1: { genres: ["Rock"] } },
    });
    const id = await seedTrack({ artist: "Test", title: "Test" });

    await enrichGenresFromDiscogs(db, env, [id]);

    const firstCall = mock.mock.calls[0];
    const firstUrl = String(firstCall?.[0]);
    expect(firstUrl).toContain("key=key");
    expect(firstUrl).toContain("secret=secret");
    const headers = (firstCall?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["User-Agent"]).toContain("CrateDigger");
  });

  it("no-ops when DISCOGS_KEY or DISCOGS_SECRET is missing", async () => {
    const mock = stubDiscogs({ masterSearch: { id: 1 } });
    const id = await seedTrack({ artist: "X", title: "Y" });

    await enrichGenresFromDiscogs(db, { ...env, DISCOGS_KEY: "" }, [id]);
    await enrichGenresFromDiscogs(db, { ...env, DISCOGS_SECRET: "" }, [id]);
    expect(mock).not.toHaveBeenCalled();

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.genreSourcesProcessed).toEqual([]);
  });

  it("idempotent — second run skips flagged tracks", async () => {
    const mock = stubDiscogs({
      masterSearch: { id: 1 },
      masters: { 1: { genres: ["Rock"] } },
    });
    const id = await seedTrack({ artist: "X", title: "Y" });

    await enrichGenresFromDiscogs(db, env, [id]);
    await enrichGenresFromDiscogs(db, env, [id]);

    // The second call must not have hit Discogs at all.
    const discogsCalls = mock.mock.calls.filter((c) => String(c[0]).includes("api.discogs.com"));
    // First run = 2 calls (search + detail). No more after.
    expect(discogsCalls).toHaveLength(2);
  });
});
