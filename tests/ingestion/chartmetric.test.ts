import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chartmetricAdapter } from "@/lib/ingestion/chartmetric";
import { _resetChartmetricTokenCache } from "@/lib/ingestion/chartmetric/client";
import type { ChartmetricBreakout } from "@/lib/ingestion/chartmetric/types";
import type { RawCandidate } from "@/lib/ingestion/types";
import type { Env } from "@/server/env";

/**
 * Round-trip test for the Chartmetric social-breakout discovery engine (LAB-117).
 *
 * Fixtures mirror the LIVE shapes verified in the spike
 * (`scripts/lab-chartmetric-engine-probe.ts`): chart rows carry ISRC + cm_track
 * + spotify_popularity + a per-platform social count inline; `/api/track/{id}`
 * returns `cm_statistics` (sp_playlist_total_reach / sp_streams) for the
 * continuous-maturity resolve hop. The engine paces calls through a rate limiter,
 * so the suite runs on fake timers (mirrors the contract test).
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
    CHARTMETRIC_REFRESH_TOKEN: "refresh-token",
    CHARTMETRIC_TRENDING_COUNTRY: "US",
    SOUNDCHARTS_APP_ID: "",
    SOUNDCHARTS_API_KEY: "",
    SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-us",
    PORT: 3000,
    NODE_ENV: "test",
    CRON_DISABLED: "",
    ...overrides,
  };
}

// A mainstream Spotify-regional hit: high maturity inline (current_plays +
// popularity), no social count → breakout ≈ 0. Resolve is skipped (it already
// has continuous maturity).
const SPOTIFY_ROWS = [
  {
    id: 1,
    cm_track: 100,
    isrc: "usmain0000001",
    name: "Megahit",
    spotify_track_id: "spmain",
    artist_names: ["Superstar"],
    spotify_popularity: 95,
    current_plays: 5_000_000,
    velocity: 0,
    rank: 1,
    pre_rank: 1,
  },
];

// A Shazam breakout: huge social count, tiny Spotify presence → high breakout.
const SHAZAM_ROWS = [
  {
    id: 2,
    cm_track: 900,
    isrc: "ushaz0000001",
    name: "Underground Anthem",
    artist_names: ["Newcomer"],
    num_of_shazams: 40_000,
    spotify_popularity: 12,
    velocity: 3.2,
    rank: 2,
    pre_rank: 9,
  },
];

const TIKTOK_ROWS = [
  {
    id: 3,
    cm_track: 901,
    isrc: "ustik0000001",
    name: "Viral Sound",
    artist_names: ["TikToker"],
    weekly_posts: 80_000,
    spotify_popularity: 20,
    velocity: 5,
    rank: 3,
    pre_rank: 15,
  },
];

// cm_statistics for the resolved social rows — low reach/streams = low maturity.
const TRACK_DETAILS: Record<string, unknown> = {
  "900": {
    id: 900,
    isrc: "ushaz0000001",
    genres: [{ id: 1, name: "hyperpop" }],
    cm_statistics: {
      sp_playlist_total_reach: 800_000,
      sp_streams: 300_000,
      sp_popularity: 12,
      shazam_counts: 40_000,
    },
  },
  "901": {
    id: 901,
    isrc: "ustik0000001",
    genres: [{ id: 2, name: "phonk" }],
    cm_statistics: {
      sp_playlist_total_reach: 1_200_000,
      sp_streams: 500_000,
      sp_popularity: 20,
      num_tt_videos: 80_000,
    },
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Mock the token exchange + the four chart endpoints + the per-track resolve. */
function stubChartmetric() {
  const mock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/token")) return jsonResponse({ token: "access-abc", expires_in: 3600 });
    if (url.includes("/api/charts/spotify")) return jsonResponse({ obj: SPOTIFY_ROWS });
    if (url.includes("/api/charts/shazam")) return jsonResponse({ obj: SHAZAM_ROWS });
    if (url.includes("/api/charts/tiktok/tracks")) return jsonResponse({ obj: TIKTOK_ROWS });
    if (url.includes("/api/charts/soundcloud")) return jsonResponse({ obj: [] });
    const trackId = /\/api\/track\/(\d+)/.exec(url)?.[1];
    if (trackId) return jsonResponse({ obj: TRACK_DETAILS[trackId] ?? {} });
    return new Response("unexpected", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Drive the rate-limiter-paced engine to completion under fake timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(120_000);
  return await p;
}

function breakoutOf(c: RawCandidate): ChartmetricBreakout {
  return (c.rawPayload as { breakout: ChartmetricBreakout }).breakout;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetChartmetricTokenCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chartmetric discovery engine (LAB-117)", () => {
  it("is available with a refresh token and is paid; unavailable without one", () => {
    expect(chartmetricAdapter.isAvailable(makeEnv())).toBe(true);
    expect(chartmetricAdapter.isAvailable(makeEnv({ CHARTMETRIC_REFRESH_TOKEN: "" }))).toBe(false);
    expect(chartmetricAdapter.isPaid).toBe(true);
  });

  it("returns [] for non-trending modes without hitting the network", async () => {
    const mock = stubChartmetric();
    const out = await settle(
      chartmetricAdapter.pullCandidates({ mode: "search", query: "x", limit: 5 }, makeEnv()),
    );
    expect(out).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it("maps charts into chartmetric candidates with ISRC + breakout on rawPayload", async () => {
    stubChartmetric();
    const out = await settle(
      chartmetricAdapter.pullCandidates({ mode: "trending", limit: 10 }, makeEnv()),
    );

    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const c of out) {
      expect(c.source).toBe("chartmetric");
      expect(breakoutOf(c).provider).toBe("chartmetric");
    }
    const mega = out.find((c) => c.title === "Megahit");
    expect(mega).toMatchObject({
      source: "chartmetric",
      isrc: "USMAIN0000001",
      spotifyId: "spmain",
    });
  });

  it("scores low-Spotify-maturity social tracks ABOVE a mainstream Spotify hit (the breakout gap)", async () => {
    stubChartmetric();
    const out = await settle(
      chartmetricAdapter.pullCandidates({ mode: "trending", limit: 10 }, makeEnv()),
    );
    const score = (title: string) => breakoutOf(out.find((c) => c.title === title)!).score;

    expect(score("Underground Anthem")).toBeGreaterThan(score("Megahit"));
    expect(score("Viral Sound")).toBeGreaterThan(score("Megahit"));
    // The mainstream hit has no social signal and saturated maturity → ~0.
    expect(score("Megahit")).toBeLessThan(0.05);
  });

  it("resolves social rows to continuous maturity + genres via one /api/track call", async () => {
    stubChartmetric();
    const out = await settle(
      chartmetricAdapter.pullCandidates({ mode: "trending", limit: 10 }, makeEnv()),
    );
    const shazam = out.find((c) => c.title === "Underground Anthem");
    if (!shazam) throw new Error("expected the shazam breakout candidate");
    expect(shazam.genres).toContain("hyperpop");
    expect(breakoutOf(shazam).signals.spotifyPlaylistReach).toBe(800_000);
  });

  it("exchanges the refresh token once and sends a bearer on chart calls", async () => {
    const mock = stubChartmetric();
    await settle(chartmetricAdapter.pullCandidates({ mode: "trending", limit: 10 }, makeEnv()));
    const tokenCalls = mock.mock.calls.filter((c) => String(c[0]).includes("/api/token"));
    expect(tokenCalls).toHaveLength(1);
    const chartCall = mock.mock.calls.find((c) => String(c[0]).includes("/api/charts/shazam"));
    expect((chartCall?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      authorization: "Bearer access-abc",
    });
  });
});
