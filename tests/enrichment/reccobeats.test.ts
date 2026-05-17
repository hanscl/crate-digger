import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { enrichAudioFeaturesForTracks, fetchAudioFeatures } from "@/lib/enrichment/reccobeats";

/**
 * ReccoBeats audio-features enrichment. `fetchAudioFeatures` is exercised
 * with stubbed `fetch` (no network); the DB-backed enrich path runs against
 * testcontainers Postgres.
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
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A well-formed ReccoBeats `{ content: [...] }` response for the asked-for ids. */
function reccobeatsOk(url: string): Response {
  const ids = (new URL(url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
  const content = ids.map((id) => ({
    id,
    tempo: 128,
    energy: 0.8,
    valence: 0.6,
    danceability: 0.7,
    acousticness: 0.1,
    instrumentalness: 0.05,
    key: 5, // bonus field — must be ignored
    mode: 1, // bonus field — must be ignored
    isrc: `isrc-${id}`,
  }));
  return new Response(JSON.stringify({ content }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function insertTrack(opts: {
  spotifyId: string | null;
  isrc?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(schema.track)
    .values({
      title: `t-${opts.spotifyId ?? "x"}`,
      artist: "artist",
      spotifyId: opts.spotifyId,
      isrc: opts.isrc ?? null,
    })
    .returning({ id: schema.track.id });
  if (!row) throw new Error("track insert returned no rows");
  return row.id;
}

describe("fetchAudioFeatures", () => {
  it("maps the six embedding features, surfaces isrc, ignores key/mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => reccobeatsOk(String(url))),
    );
    const out = await fetchAudioFeatures(["sp1"]);
    const f = out.get("sp1");
    expect(f).toEqual({
      tempo: 128,
      energy: 0.8,
      valence: 0.6,
      danceability: 0.7,
      acousticness: 0.1,
      instrumentalness: 0.05,
      isrc: "ISRC-SP1",
    });
    // The bonus key/mode fields are intentionally not on FetchedFeatures.
    expect(f).not.toHaveProperty("key");
    expect(f).not.toHaveProperty("mode");
  });

  it("recovers the Spotify id from a href when the entry has no id field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [
                {
                  href: "https://open.spotify.com/track/sp9",
                  tempo: 100,
                  energy: 0.5,
                  valence: 0.5,
                  danceability: 0.5,
                  acousticness: 0.5,
                  instrumentalness: 0.5,
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const out = await fetchAudioFeatures(["sp9"]);
    expect(out.get("sp9")?.tempo).toBe(100);
  });

  it("returns an empty map and does not throw on a 404 / malformed / empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    expect((await fetchAudioFeatures(["sp1"])).size).toBe(0);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json{", { status: 200 })),
    );
    expect((await fetchAudioFeatures(["sp1"])).size).toBe(0);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ content: [] }), { status: 200 })),
    );
    expect((await fetchAudioFeatures(["sp1"])).size).toBe(0);
  });

  it("batches at most 5 Spotify ids per request", async () => {
    const fetchMock = vi.fn(async (url: string) => reccobeatsOk(String(url)));
    vi.stubGlobal("fetch", fetchMock);

    const ids = Array.from({ length: 12 }, (_, i) => `sp${i}`);
    const out = await fetchAudioFeatures(ids);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 5 + 5 + 2
    for (const call of fetchMock.mock.calls) {
      const idsParam = new URL(String(call[0])).searchParams.get("ids") ?? "";
      expect(idsParam.split(",").length).toBeLessThanOrEqual(5);
    }
    expect(out.size).toBe(12);
  });
});

describe("enrichAudioFeaturesForTracks", () => {
  it("writes audio features and backfills a null isrc without overwriting an existing one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => reccobeatsOk(String(url))),
    );
    const noIsrc = await insertTrack({ spotifyId: "sp1", isrc: null });
    const hasIsrc = await insertTrack({ spotifyId: "sp2", isrc: "REAL-ISRC-22" });

    const result = await enrichAudioFeaturesForTracks(db, [noIsrc, hasIsrc]);
    expect(result.updated).toBe(2);
    expect(result.isrcBackfilled).toBe(1);

    const rows = await db.select().from(schema.track);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(noIsrc)?.audioFeatures?.tempo).toBe(128);
    expect(byId.get(noIsrc)?.isrc).toBe("ISRC-SP1"); // backfilled
    expect(byId.get(hasIsrc)?.audioFeatures?.energy).toBe(0.8);
    expect(byId.get(hasIsrc)?.isrc).toBe("REAL-ISRC-22"); // not overwritten
  });

  it("is idempotent — a second run does not refetch tracks that already have features", async () => {
    const fetchMock = vi.fn(async (url: string) => reccobeatsOk(String(url)));
    vi.stubGlobal("fetch", fetchMock);
    const id = await insertTrack({ spotifyId: "sp1" });

    await enrichAudioFeaturesForTracks(db, [id]);
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await enrichAudioFeaturesForTracks(db, [id]);

    expect(second.updated).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no refetch
  });

  it("skips fetching entirely when reccobeats is toggled off", async () => {
    const fetchMock = vi.fn(async (url: string) => reccobeatsOk(String(url)));
    vi.stubGlobal("fetch", fetchMock);
    await db.insert(schema.appConfig).values({
      id: 1,
      sourcesEnabled: { spotify: true, lastfm: true, viberate: false, reccobeats: false },
    });
    const id = await insertTrack({ spotifyId: "sp1" });

    const result = await enrichAudioFeaturesForTracks(db, [id]);
    expect(result.updated).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const [row] = await db.select().from(schema.track).where(eq(schema.track.id, id));
    expect(row?.audioFeatures).toBeNull();
  });
});
