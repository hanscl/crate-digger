import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ViberateVelocity, viberateAdapter } from "@/lib/ingestion/viberate";
import type { Env } from "@/server/env";

/**
 * Round-trip test for the Viberate trending adapter (LAB-88).
 *
 * Fixtures model the LIVE `/track/trending/spotify/country` response shape
 * verified during the LAB-87 spike (2026-06-12) — each row carries the Spotify
 * `track_id`, ISRC, artist credits and the velocity signal. The test pins the
 * row → RawCandidate mapping, the unresolvable-row drop, the request contract
 * (path + Access-Key header + clamped limit), and the trending-only degrade.
 * Graceful degradation on missing creds / upstream errors is covered by the
 * shared adapter-contract suite.
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
    CHARTMETRIC_TIKTOK_COUNTRY: "US",
    SOUNDCHARTS_APP_ID: "",
    SOUNDCHARTS_API_KEY: "",
    SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-us",
    PORT: 3000,
    NODE_ENV: "test",
    CRON_DISABLED: "",
    ...overrides,
  };
}

const TRENDING = {
  api_version: "v1.37.00",
  data: [
    {
      track_id: "20jbSiX29FDX4oQxBXyUEi",
      title: "hate that i made you love me",
      isrc: "USUM72601821",
      release_date: "2026-05-29",
      artists: [{ uuid: "a1", name: "Ariana Grande", slug: "ariana-grande" }],
      streams_1d: 1922463,
      streams_1d_prev: 1509234,
      streams_1d_pct: 27.38,
      ranks: { rank: 1, rank_diff: 1 },
    },
    {
      // lowercase isrc must be uppercased; multi-artist joined primary-first
      track_id: "65DbTqJKhbwqYbZ1Okr0rc",
      title: "Choosin' Texas",
      isrc: "ussm12504190",
      release_date: "2025-01-10",
      artists: [{ name: "Ella Langley" }, { name: "Riley Green" }],
      streams_1d_pct: 11.89,
      ranks: { rank: 3, rank_diff: 0 },
    },
    {
      // unresolvable — no isrc AND no artist — must be dropped
      track_id: "ghost",
      title: "Ghost Track",
      isrc: null,
      artists: [],
    },
    {
      // no title — must be dropped
      track_id: "untitled",
      isrc: "USABC1234567",
      artists: [{ name: "No Title" }],
    },
  ],
};

function stubFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("viberate adapter", () => {
  it("is available only with an api key", () => {
    expect(viberateAdapter.isAvailable(makeEnv({ VIBERATE_API_KEY: "" }))).toBe(false);
    expect(viberateAdapter.isAvailable(makeEnv())).toBe(true);
  });

  it("maps trending rows to RawCandidates and drops unresolvable ones", async () => {
    stubFetchJson(TRENDING);
    const out = await viberateAdapter.pullCandidates({ mode: "trending", limit: 10 }, makeEnv());
    expect(out).toHaveLength(2); // two valid; ghost + untitled dropped

    const [a, b] = out;
    expect(a).toMatchObject({
      source: "viberate",
      sourceTrackId: "20jbSiX29FDX4oQxBXyUEi",
      // The trending endpoint is Spotify's chart — track_id IS a Spotify id.
      spotifyId: "20jbSiX29FDX4oQxBXyUEi",
      isrc: "USUM72601821",
      title: "hate that i made you love me",
      artist: "Ariana Grande",
      album: null,
      releaseYear: 2026,
      durationMs: null,
      genres: [],
    });
    const vel = (a!.rawPayload as { velocity: ViberateVelocity }).velocity;
    expect(vel).toMatchObject({
      provider: "viberate",
      country: "US",
      streams1dPct: 27.38,
      rank: 1,
      rankDiff: 1,
    });

    // lowercase isrc uppercased; multi-artist joined primary-first
    expect(b).toMatchObject({
      isrc: "USSM12504190",
      artist: "Ella Langley, Riley Green",
      releaseYear: 2025,
    });
  });

  it("requests the Spotify trending chart with the Access-Key header and clamps the limit", async () => {
    const fetchFn = stubFetchJson({ data: [] });
    await viberateAdapter.pullCandidates(
      { mode: "trending", limit: 999 },
      makeEnv({ VIBERATE_TRENDING_COUNTRY: "DE" }),
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("data.viberate.com/api/v1/track/trending/spotify/country");
    expect(url).toContain("country=DE");
    expect(url).toContain("limit=50"); // clamped to MAX_TRENDING_ROWS
    expect(init.headers).toMatchObject({ "Access-Key": "vib-key" });
  });

  it("returns [] for non-array data without throwing", async () => {
    stubFetchJson({ api_version: "v1", data: null });
    await expect(
      viberateAdapter.pullCandidates({ mode: "trending", limit: 5 }, makeEnv()),
    ).resolves.toEqual([]);
  });

  it("does not call the network for search/similar modes (trending-only)", async () => {
    const fetchFn = stubFetchJson(TRENDING);
    const search = await viberateAdapter.pullCandidates(
      { mode: "search", query: "x", limit: 5 },
      makeEnv(),
    );
    const similar = await viberateAdapter.pullCandidates(
      { mode: "similar", seedArtist: "A", seedTrack: "B", limit: 5 },
      makeEnv(),
    );
    expect(search).toEqual([]);
    expect(similar).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not hit the network without credentials", async () => {
    const fetchFn = stubFetchJson(TRENDING);
    const out = await viberateAdapter.pullCandidates(
      { mode: "trending", limit: 5 },
      makeEnv({ VIBERATE_API_KEY: "" }),
    );
    expect(out).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
