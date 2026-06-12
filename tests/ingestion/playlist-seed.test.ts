import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playlistSeedAdapter } from "@/lib/ingestion/playlist-seed";
import { _resetSpotifyTokenCache, type SpotifyTrack } from "@/lib/ingestion/spotify";
import type { Env } from "@/server/env";

/**
 * LAB-84 — playlist-seed adapter. Pure unit tests with stubbed `fetch` (no
 * network, no DB), mirroring `spotify-resolve.test.ts`. The stub answers the
 * token endpoint and `/playlists/{id}/tracks`.
 */

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgres://localhost/test",
    ADMIN_PASSPHRASE: "x",
    ANTHROPIC_API_KEY: "",
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REDIRECT_URI: "http://127.0.0.1:3000/api/auth/spotify/callback",
    LASTFM_API_KEY: "",
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
    ...over,
  };
}

function spotifyTrack(over: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: "sp-1",
    name: "Bella Kay Song",
    artists: [{ id: "a1", name: "Bella Kay" }],
    album: { id: "al1", name: "Tail Cuts", release_date: "2026" },
    external_ids: { isrc: "usrc12345678" },
    duration_ms: 180_000,
    popularity: 17,
    ...over,
  };
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type PlaylistItem = { track: SpotifyTrack | null };

/** A 200 `/playlists/{id}/tracks` page. */
function playlistPage(items: PlaylistItem[], next: string | null = null): Response {
  return new Response(JSON.stringify({ items, next }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stub fetch to answer the token endpoint and each `/playlists/{id}/tracks`
 * call. `pagesByPlaylist` maps a playlist id to the ordered list of page
 * responses it should return (one per `offset` page).
 */
function stubFetch(pagesByPlaylist: Record<string, Response[]>): ReturnType<typeof vi.fn> {
  const cursors: Record<string, number> = {};
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("accounts.spotify.com")) return tokenResponse();
    const m = /\/playlists\/([^/]+)\/tracks/.exec(url);
    if (m?.[1]) {
      const id = m[1];
      const pages = pagesByPlaylist[id] ?? [playlistPage([])];
      const idx = cursors[id] ?? 0;
      cursors[id] = idx + 1;
      return pages[idx] ?? playlistPage([]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  _resetSpotifyTokenCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("playlistSeedAdapter", () => {
  it("is a free adapter available wherever Spotify creds are present", () => {
    expect(playlistSeedAdapter.id).toBe("tiktok-playlist-seed");
    expect(playlistSeedAdapter.isPaid).toBe(false);
    expect(playlistSeedAdapter.isAvailable(makeEnv())).toBe(true);
    expect(
      playlistSeedAdapter.isAvailable(
        makeEnv({ SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "" }),
      ),
    ).toBe(false);
  });

  it("pulls playlist tracks as tiktok-playlist-seed candidates carrying spotifyId + popularity", async () => {
    stubFetch({ pl1: [playlistPage([{ track: spotifyTrack() }])] });
    const out = await playlistSeedAdapter.pullCandidates(
      { mode: "trending", playlistIds: ["pl1"] },
      makeEnv(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "tiktok-playlist-seed",
      sourceTrackId: "sp-1",
      spotifyId: "sp-1",
      isrc: "USRC12345678", // normalized upper-case
      popularity: 17,
      artist: "Bella Kay",
    });
  });

  it("aggregates across multiple playlists and skips null (local/removed) tracks", async () => {
    stubFetch({
      pl1: [playlistPage([{ track: spotifyTrack({ id: "sp-1" }) }, { track: null }])],
      pl2: [playlistPage([{ track: spotifyTrack({ id: "sp-2", name: "STELLA LEFTY" }) }])],
    });
    const out = await playlistSeedAdapter.pullCandidates(
      { mode: "trending", playlistIds: ["pl1", "pl2"] },
      makeEnv(),
    );
    expect(out.map((c) => c.spotifyId)).toEqual(["sp-1", "sp-2"]);
    expect(out.every((c) => c.source === "tiktok-playlist-seed")).toBe(true);
  });

  it("pages a playlist via the next cursor", async () => {
    stubFetch({
      pl1: [
        playlistPage([{ track: spotifyTrack({ id: "sp-1" }) }], "next-url"),
        playlistPage([{ track: spotifyTrack({ id: "sp-2" }) }], null),
      ],
    });
    const out = await playlistSeedAdapter.pullCandidates(
      { mode: "trending", playlistIds: ["pl1"] },
      makeEnv(),
    );
    expect(out.map((c) => c.spotifyId)).toEqual(["sp-1", "sp-2"]);
  });

  it("captures null popularity when Spotify omits it", async () => {
    stubFetch({ pl1: [playlistPage([{ track: spotifyTrack({ popularity: undefined }) }])] });
    const out = await playlistSeedAdapter.pullCandidates(
      { mode: "trending", playlistIds: ["pl1"] },
      makeEnv(),
    );
    expect(out[0]?.popularity).toBeNull();
  });

  it("returns [] (no fetch) without playlist IDs", async () => {
    const fn = stubFetch({});
    expect(await playlistSeedAdapter.pullCandidates({ mode: "trending" }, makeEnv())).toEqual([]);
    expect(
      await playlistSeedAdapter.pullCandidates({ mode: "trending", playlistIds: [] }, makeEnv()),
    ).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns [] for search and similar modes", async () => {
    expect(
      await playlistSeedAdapter.pullCandidates({ mode: "search", query: "x" }, makeEnv()),
    ).toEqual([]);
    expect(
      await playlistSeedAdapter.pullCandidates(
        { mode: "similar", seedArtist: "a", seedTrack: "t" },
        makeEnv(),
      ),
    ).toEqual([]);
  });

  it("returns [] without Spotify credentials even when playlist IDs are configured", async () => {
    const out = await playlistSeedAdapter.pullCandidates(
      { mode: "trending", playlistIds: ["pl1"] },
      makeEnv({ SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "" }),
    );
    expect(out).toEqual([]);
  });

  it("degrades to [] (never throws) when the playlist endpoint errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("accounts.spotify.com")) return tokenResponse();
        return new Response("boom", { status: 500 });
      }),
    );
    await expect(
      playlistSeedAdapter.pullCandidates({ mode: "trending", playlistIds: ["pl1"] }, makeEnv()),
    ).resolves.toEqual([]);
  });
});
