import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tiktokAdapter } from "@/lib/ingestion/tiktok";
import type { TikTokVelocity } from "@/lib/ingestion/soundcharts";
import type { Env } from "@/server/env";

/**
 * Round-trip test for the TikTok-velocity adapter (LAB-19). Fixtures mirror
 * the live Soundcharts response shapes (verified against the public sandbox):
 *  - chart ranking: items[].song.{uuid,name,creditName} + position/velocity
 *  - song metadata: object.{isrc,mainArtists,duration(seconds),releaseDate}
 */

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgres://localhost:5432/test",
    ADMIN_PASSPHRASE: "x",
    ANTHROPIC_API_KEY: "",
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SPOTIFY_REDIRECT_URI: "http://localhost:3000/cb",
    LASTFM_API_KEY: "",
    MUSICBRAINZ_CONTACT_EMAIL: "",
    DISCOGS_KEY: "",
    DISCOGS_SECRET: "",
    VIBERATE_API_KEY: "",
    VIBERATE_TRENDING_COUNTRY: "US",
    CHARTMETRIC_REFRESH_TOKEN: "",
    CHARTMETRIC_TRENDING_COUNTRY: "US",
    SOUNDCHARTS_APP_ID: "app",
    SOUNDCHARTS_API_KEY: "key",
    SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-us",
    PORT: 3000,
    NODE_ENV: "test",
    CRON_DISABLED: "",
    ...overrides,
  };
}

const CHART = {
  related: {
    chart: { slug: "tiktok-breakout-us", platform: "tiktok" },
    date: "2026-06-09T12:00:00+00:00",
  },
  items: [
    {
      song: { uuid: "uuid-climber", name: "Skyfall Sped Up", creditName: "Rising Star" },
      position: 3,
      positionEvolution: 12,
      timeOnChart: 4,
      rankDate: "2026-06-09T12:00:00+00:00",
    },
    {
      // creditName-only fallback case: its metadata lookup will 500.
      song: { uuid: "uuid-nometa", name: "No Meta Anthem", creditName: "Fallback Crew" },
      position: 7,
      positionEvolution: -2,
      timeOnChart: 19,
      rankDate: "2026-06-09T12:00:00+00:00",
    },
  ],
  page: { offset: 0, limit: 10, next: null, previous: null, total: 2 },
  errors: [],
};

const SONG_META: Record<string, unknown> = {
  "uuid-climber": {
    type: "song",
    object: {
      uuid: "uuid-climber",
      name: "Skyfall Sped Up",
      isrc: "usrc12300456",
      creditName: "Rising Star",
      mainArtists: [{ uuid: "a1", name: "Rising Star" }],
      releaseDate: "2026-04-01T00:00:00+00:00",
      duration: 138,
    },
    errors: [],
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Mock the two Soundcharts endpoints; `uuid-nometa` 500s on its song lookup. */
function stubSoundcharts() {
  const mock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/ranking/latest")) return jsonResponse(CHART);
    const uuid = /\/song\/([^/?]+)/.exec(url)?.[1];
    if (uuid) {
      const meta = SONG_META[uuid];
      if (!meta) return new Response("not found", { status: 500 });
      return jsonResponse(meta);
    }
    return new Response("unexpected", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tiktok adapter (Soundcharts)", () => {
  it("is unavailable without both credentials", () => {
    expect(
      tiktokAdapter.isAvailable(makeEnv({ SOUNDCHARTS_APP_ID: "", SOUNDCHARTS_API_KEY: "" })),
    ).toBe(false);
    expect(tiktokAdapter.isAvailable(makeEnv({ SOUNDCHARTS_API_KEY: "" }))).toBe(false);
    expect(tiktokAdapter.isAvailable(makeEnv({ SOUNDCHARTS_APP_ID: "" }))).toBe(false);
    expect(tiktokAdapter.isAvailable(makeEnv())).toBe(true);
    expect(tiktokAdapter.isPaid).toBe(true);
  });

  it("returns [] for non-trending modes without hitting the network", async () => {
    const mock = stubSoundcharts();
    const out = await tiktokAdapter.pullCandidates(
      { mode: "search", query: "x", limit: 5 },
      makeEnv(),
    );
    expect(out).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it("maps a breakout chart into candidates with ISRC + velocity in rawPayload", async () => {
    const mock = stubSoundcharts();
    const out = await tiktokAdapter.pullCandidates({ mode: "trending", limit: 3 }, makeEnv());

    // chart pull uses the configured slug + clamped limit
    const chartCall = mock.mock.calls.find((c) => String(c[0]).includes("/ranking/latest"));
    expect(String(chartCall?.[0])).toContain("/chart/song/tiktok-breakout-us/ranking/latest");
    expect(String(chartCall?.[0])).toContain("limit=3");
    // auth headers are sent
    expect((chartCall?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      "x-app-id": "app",
      "x-api-key": "key",
    });

    expect(out).toHaveLength(2);
    const climber = out[0];
    if (!climber) throw new Error("expected a charted candidate");
    expect(climber).toMatchObject({
      source: "tiktok",
      sourceTrackId: "uuid-climber",
      isrc: "USRC12300456", // normalized upper-case
      spotifyId: null,
      title: "Skyfall Sped Up",
      artist: "Rising Star",
      releaseYear: 2026,
      durationMs: 138_000, // seconds → ms
    });
    const velocity = (climber.rawPayload as { velocity: TikTokVelocity }).velocity;
    expect(velocity).toMatchObject({
      provider: "soundcharts",
      chartSlug: "tiktok-breakout-us",
      position: 3,
      positionEvolution: 12,
      timeOnChart: 4,
    });
  });

  it("still emits a candidate when the song-metadata lookup fails (fuzzy fallback)", async () => {
    stubSoundcharts();
    const out = await tiktokAdapter.pullCandidates({ mode: "trending", limit: 3 }, makeEnv());
    const noMeta = out.find((c) => c.sourceTrackId === "uuid-nometa");
    expect(noMeta).toBeDefined();
    // No ISRC available, artist falls back to the chart row's creditName.
    expect(noMeta?.isrc).toBeNull();
    expect(noMeta?.artist).toBe("Fallback Crew");
    expect(noMeta?.durationMs).toBeNull();
    expect(noMeta?.releaseYear).toBeNull();
  });

  it("honours a configured non-default chart slug", async () => {
    const mock = stubSoundcharts();
    await tiktokAdapter.pullCandidates(
      { mode: "trending", limit: 5 },
      makeEnv({ SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-gb" }),
    );
    const chartCall = mock.mock.calls.find((c) => String(c[0]).includes("/ranking/latest"));
    expect(String(chartCall?.[0])).toContain("/chart/song/tiktok-breakout-gb/ranking/latest");
  });
});
