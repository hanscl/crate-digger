import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastfmAdapter } from "@/lib/ingestion/lastfm";
import { _resetSpotifyTokenCache, spotifyAdapter } from "@/lib/ingestion/spotify";
import type { Env } from "@/server/env";

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
    SOUNDCHARTS_APP_ID: "",
    SOUNDCHARTS_API_KEY: "",
    SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-us",
    PORT: 3000,
    NODE_ENV: "test",
    CRON_DISABLED: "",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  _resetSpotifyTokenCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Last.fm explore pull (LAB-40 tag.getTopTracks)", () => {
  it("pulls tag.getTopTracks per genre and maps to lastfm RawCandidates", async () => {
    const calls: { method: string | null; tag: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = new URL(String(url));
        const method = u.searchParams.get("method");
        const tag = u.searchParams.get("tag");
        calls.push({ method, tag });
        return jsonResponse({
          tracks: {
            track: [{ name: `${tag} Hit`, artist: { name: `${tag} Artist` }, duration: "200" }],
          },
        });
      }),
    );

    const out = await lastfmAdapter.pullCandidates(
      { mode: "explore", genres: ["jazz", "ambient"], limit: 4 },
      makeEnv({ LASTFM_API_KEY: "key" }),
    );

    // One tag.getTopTracks call per genre, each via the correct method.
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === "tag.getTopTracks")).toBe(true);
    expect(calls.map((c) => c.tag)).toEqual(["jazz", "ambient"]);
    // Both genres' tracks reached the pool, stamped source='lastfm'.
    expect(out.map((c) => c.title)).toEqual(["jazz Hit", "ambient Hit"]);
    expect(out.every((c) => c.source === "lastfm")).toBe(true);
    expect(out.every((c) => c.durationMs === 200_000)).toBe(true);
  });

  it("returns [] for an empty genre batch (no upstream call)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const out = await lastfmAdapter.pullCandidates(
      { mode: "explore", genres: [], limit: 4 },
      makeEnv({ LASTFM_API_KEY: "key" }),
    );
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips a tag that errors rather than failing the whole pull (Constraint #1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const tag = new URL(String(url)).searchParams.get("tag");
        if (tag === "jazz") return new Response("boom", { status: 500 });
        return jsonResponse({
          tracks: { track: [{ name: `${tag} Hit`, artist: { name: "A" }, duration: "200" }] },
        });
      }),
    );
    const out = await lastfmAdapter.pullCandidates(
      { mode: "explore", genres: ["jazz", "ambient"], limit: 4 },
      makeEnv({ LASTFM_API_KEY: "key" }),
    );
    expect(out.map((c) => c.title)).toEqual(["ambient Hit"]);
  });

  it("returns [] when the adapter is unavailable (no API key)", async () => {
    const out = await lastfmAdapter.pullCandidates(
      { mode: "explore", genres: ["jazz"], limit: 4 },
      makeEnv(),
    );
    expect(out).toEqual([]);
  });
});

describe("Spotify explore pull (LAB-40 genre-filtered search)", () => {
  it("issues a genre-filtered /search per genre and maps to spotify RawCandidates", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("accounts.spotify.com")) {
          return jsonResponse({ access_token: "tok", expires_in: 3600 });
        }
        const q = new URL(u).searchParams.get("q") ?? "";
        queries.push(q);
        return jsonResponse({
          tracks: {
            items: [
              {
                id: `${q}-1`,
                name: `${q} track`,
                artists: [{ id: "a", name: "Artist" }],
                album: { id: "al", name: "Album", release_date: "2024" },
                external_ids: { isrc: "GBxxx0000001" },
                duration_ms: 200_000,
              },
            ],
            next: null,
          },
        });
      }),
    );

    const out = await spotifyAdapter.pullCandidates(
      { mode: "explore", genres: ["jazz"], limit: 2 },
      makeEnv({ SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" }),
    );

    // The genre filter was quoted into the search query.
    expect(queries.some((q) => q.includes('genre:"jazz"'))).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.source === "spotify")).toBe(true);
  });

  it("returns [] for an empty genre batch (no upstream call)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: "tok", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await spotifyAdapter.pullCandidates(
      { mode: "explore", genres: [], limit: 2 },
      makeEnv({ SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" }),
    );
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
