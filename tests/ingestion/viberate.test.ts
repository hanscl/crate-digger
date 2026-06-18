import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viberateAdapter } from "@/lib/ingestion/viberate";
import type { ViberateBreakout } from "@/lib/ingestion/viberate/types";
import type { RawCandidate } from "@/lib/ingestion/types";
import type { Env } from "@/server/env";

/**
 * Integration test for the Viberate social-breakout engine (LAB-90).
 *
 * A routed fetch mock serves the live shapes verified in the LAB-90 spike for
 * each feed + resolution endpoint. Fake timers drive the multi-call rate
 * limiter so the ~1.1s pacing doesn't blow vitest's 5s timeout. Pins: the
 * multi-feed pull contract, ISRC resolution per feed, the breakout signal on
 * rawPayload, breakout-weighted composition (Spotify-trending de-emphasized),
 * and trending-only / no-creds degradation.
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
    VIBERATE_API_KEY: "vib-key",
    VIBERATE_TRENDING_COUNTRY: "US",
    CHARTMETRIC_REFRESH_TOKEN: "",
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

const SPOTIFY_TRENDING = {
  data: [
    {
      track_id: "spot1",
      title: "Big Hit",
      isrc: "USSPOT1111111",
      release_date: "2026-01-01",
      artists: [{ name: "Famous" }],
      streams_1d: 1_900_000,
      streams_1d_pct: 12,
      ranks: { rank: 1, rank_diff: 0 },
    },
  ],
};

const YOUTUBE_TRENDING = {
  data: [
    {
      track_id: "G:abc",
      youtube_id: "yt1",
      title: "YT Breakout",
      release_date: "2026-05-01",
      artists: [{ name: "YT Artist" }],
      views_1w: 800_000,
      views_1w_pct: 400,
    },
  ],
};

const COMPOSITE_CHART = {
  data: [
    {
      uuid: "comp1",
      name: "Shazam Breakout",
      release_date: "2026-04-01",
      artists: [{ name: "Indie One" }],
      genre: { name: "R&B" },
      charts: {
        shazam: { shazams: { "1w": 8_000, total: "9000" } },
        spotify: { streams: { "1w": 2_000, total: "5000" } },
      },
    },
  ],
};

// keyed resolution responses
const BY_CHANNEL_YT1 = {
  data: {
    uuid: "ytuuid1",
    isrc: "ussyt2222222", // lowercase → must normalize
    genre: { name: "Pop" },
    subgenres: [{ name: "Hyperpop" }],
    release_date: "2026-05-01",
  },
};
const DETAILS_COMP1 = {
  data: {
    uuid: "comp1",
    isrc: "UScomp3333333",
    genre: { name: "R&B" },
    subgenres: [{ name: "Alt R&B" }],
    release_date: "2026-04-01",
  },
};
const STATS_YTUUID1 = {
  data: { "spotify-streams": 3_000, "spotify-playlist_reach": 1_000, "shazam-shazams": 1_500 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route by URL substring to the right fixture; default {data:[]}. */
function routeFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("by-channel/youtube/")) return jsonResponse(BY_CHANNEL_YT1);
    if (url.includes("stats-alltime")) return jsonResponse(STATS_YTUUID1);
    if (url.includes("/details")) return jsonResponse(DETAILS_COMP1);
    if (url.includes("trending/spotify")) return jsonResponse(SPOTIFY_TRENDING);
    if (url.includes("trending/youtube")) return jsonResponse(YOUTUBE_TRENDING);
    if (url.includes("viberate/chart")) return jsonResponse(COMPOSITE_CHART);
    return jsonResponse({ data: [] });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const breakoutOf = (c: RawCandidate): ViberateBreakout =>
  (c.rawPayload as { breakout: ViberateBreakout }).breakout;
const byFeed = (out: RawCandidate[], feed: ViberateBreakout["feed"]): RawCandidate | undefined =>
  out.find((c) => breakoutOf(c).feed === feed);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Run the adapter, advancing fake time so the rate-limiter pacing resolves. */
async function drivePull(params: Parameters<typeof viberateAdapter.pullCandidates>[0], env: Env) {
  const p = viberateAdapter.pullCandidates(params, env);
  // Worst case ≈ 6 chart + MAX_RETURN*2 resolution calls × 1.1s pacing (~120s);
  // 300s leaves comfortable headroom for a full-budget run.
  await vi.advanceTimersByTimeAsync(300_000);
  return await p;
}

describe("viberate breakout engine", () => {
  it("is available only with an api key", () => {
    expect(viberateAdapter.isAvailable(makeEnv({ VIBERATE_API_KEY: "" }))).toBe(false);
    expect(viberateAdapter.isAvailable(makeEnv())).toBe(true);
  });

  it("pulls the multi-feed pool and emits resolved breakout candidates", async () => {
    routeFetch();
    const out = await drivePull({ mode: "trending", limit: 10 }, makeEnv());

    expect(out).toHaveLength(3); // composite + youtube + spotify (deduped across countries/sorts)
    for (const c of out) {
      expect(c.source).toBe("viberate");
      const b = breakoutOf(c);
      expect(b.provider).toBe("viberate");
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(1);
    }

    // composite ISRC comes from /details (normalized upper)
    expect(byFeed(out, "composite-chart")).toMatchObject({
      isrc: "USCOMP3333333",
      spotifyId: null,
      title: "Shazam Breakout",
      artist: "Indie One",
    });
    // youtube ISRC comes from /by-channel (normalized upper)
    expect(byFeed(out, "youtube-trending")).toMatchObject({
      isrc: "USSYT2222222",
      spotifyId: null,
      artist: "YT Artist",
    });
    // spotify-trending carries the Spotify id + ISRC directly
    expect(byFeed(out, "spotify-trending")).toMatchObject({
      isrc: "USSPOT1111111",
      spotifyId: "spot1",
    });
  });

  it("composes toward breakouts — Spotify-trending mainstream ranks last", async () => {
    routeFetch();
    const out = await drivePull({ mode: "trending", limit: 10 }, makeEnv());
    // The Spotify-native mainstream track is the lowest-weighted breakout.
    expect(breakoutOf(out[out.length - 1]!).feed).toBe("spotify-trending");
    const spotify = byFeed(out, "spotify-trending")!;
    const composite = byFeed(out, "composite-chart")!;
    expect(breakoutOf(spotify).score).toBeLessThan(breakoutOf(composite).score);
  });

  it("sweeps each feed/territory with the Access-Key header", async () => {
    const fetchFn = routeFetch();
    await drivePull({ mode: "trending", limit: 10 }, makeEnv());
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("trending/youtube/country"))).toHaveLength(3); // US/GB/DE
    expect(urls.filter((u) => u.includes("viberate/chart"))).toHaveLength(2); // shazam + soundcloud
    expect(urls.filter((u) => u.includes("trending/spotify/country"))).toHaveLength(1);
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ "Access-Key": "vib-key" });
    // TikTok is shipped OFF (metered requested-track registration not verified):
    // no run may touch the requested-track / tiktok endpoints.
    expect(urls.every((u) => !u.includes("requested-track") && !/tiktok/i.test(u))).toBe(true);
  });

  it("survives a partial feed failure — other feeds still produce candidates", async () => {
    // YouTube trending 500s; composite + spotify keep working.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("trending/youtube")) return jsonResponse("boom", 500);
        if (url.includes("/details")) return jsonResponse(DETAILS_COMP1);
        if (url.includes("trending/spotify")) return jsonResponse(SPOTIFY_TRENDING);
        if (url.includes("viberate/chart")) return jsonResponse(COMPOSITE_CHART);
        return jsonResponse({ data: [] });
      }),
    );
    const out = await drivePull({ mode: "trending", limit: 10 }, makeEnv());
    const feeds = out.map((c) => breakoutOf(c).feed);
    expect(feeds).toContain("composite-chart");
    expect(feeds).toContain("spotify-trending");
    expect(feeds).not.toContain("youtube-trending"); // the failed feed contributes nothing
  });

  it("bounds the shortlist + resolution to the throttle limit (pull composition)", async () => {
    // Composite returns 4 distinct breakout rows; limit=2 ⇒ only the top 2 emit
    // and only 2 resolution (/details) calls fire.
    const fourComposite = {
      data: [0, 1, 2, 3].map((i) => ({
        uuid: `c${i}`,
        name: `Track ${i}`,
        artists: [{ name: `Artist ${i}` }],
        genre: { name: "R&B" },
        charts: {
          shazam: { shazams: { "1w": (i + 1) * 2_000 } },
          spotify: { streams: { total: "1000" } },
        },
      })),
    };
    const fetchFn = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/details")) return jsonResponse({ data: { isrc: "USDET0000001" } });
      if (url.includes("viberate/chart")) return jsonResponse(fourComposite);
      return jsonResponse({ data: [] }); // youtube + spotify empty
    });
    vi.stubGlobal("fetch", fetchFn);

    const out = await drivePull({ mode: "trending", limit: 2 }, makeEnv());
    expect(out).toHaveLength(2);
    const detailsCalls = fetchFn.mock.calls.filter((c) => String(c[0]).includes("/details"));
    expect(detailsCalls).toHaveLength(2); // only the shortlist is resolved
  });

  it("returns [] (no throw) when every feed yields non-array data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ api_version: "v1", data: null })),
    );
    await expect(drivePull({ mode: "trending", limit: 5 }, makeEnv())).resolves.toEqual([]);
  });

  it("does not call the network for search/similar modes", async () => {
    const fetchFn = routeFetch();
    expect(await drivePull({ mode: "search", query: "x", limit: 5 }, makeEnv())).toEqual([]);
    expect(
      await drivePull({ mode: "similar", seedArtist: "A", seedTrack: "B", limit: 5 }, makeEnv()),
    ).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not hit the network without credentials", async () => {
    const fetchFn = routeFetch();
    const out = await drivePull({ mode: "trending", limit: 5 }, makeEnv({ VIBERATE_API_KEY: "" }));
    expect(out).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
