import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSpotifyId } from "@/lib/enrichment/resolve";
import {
  _resetSpotifyTokenCache,
  searchSpotifyTrack,
  type SpotifyTrack,
} from "@/lib/ingestion/spotify";
import type { RawCandidate } from "@/lib/ingestion/types";
import type { Env } from "@/server/env";

/**
 * LAB-46: ingest-time Spotify-id resolution. Pure unit tests with stubbed
 * `fetch` (no network, no DB) — mirrors `reccobeats.test.ts`'s style. The
 * Spotify client caches its access token at module scope, so we reset it in
 * `beforeEach`; the fetch stub answers BOTH the token endpoint and `/search`.
 */

/** Env with non-empty Spotify creds (resolution pass active). */
function envWithCreds(over: Partial<Env> = {}): Env {
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
    PORT: 3000,
    NODE_ENV: "test",
    CRON_DISABLED: "",
    ...over,
  };
}

function lastfmCandidate(over: Partial<RawCandidate> = {}): RawCandidate {
  return {
    source: "lastfm",
    sourceTrackId: "lf-1",
    isrc: null,
    spotifyId: null,
    title: "Reckoner",
    artist: "Radiohead",
    album: null,
    releaseYear: null,
    durationMs: null,
    genres: [],
    rawPayload: {},
    ...over,
  };
}

function spotifyTrack(over: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: "sp-reckoner",
    name: "Reckoner",
    artists: [{ id: "a1", name: "Radiohead" }],
    album: { id: "al1", name: "In Rainbows", release_date: "2007" },
    external_ids: { isrc: "gbaye0700743" },
    duration_ms: 290_000,
    ...over,
  };
}

/** A 200 token response from accounts.spotify.com. */
function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A 200 `/search` response wrapping the given items. */
function searchResponse(items: SpotifyTrack[]): Response {
  return new Response(JSON.stringify({ tracks: { items } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stub fetch to answer the token endpoint and `/search`. `searchItems` is the
 * items array returned by `/search` (use `null` to make `/search` 404).
 */
function stubFetch(searchItems: SpotifyTrack[] | null): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("accounts.spotify.com")) return tokenResponse();
    if (url.includes("/v1/search")) {
      return searchItems === null
        ? new Response("nope", { status: 404 })
        : searchResponse(searchItems);
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

describe("searchSpotifyTrack", () => {
  it("returns the SpotifyTrack items from a /search payload in order", async () => {
    const hit = spotifyTrack();
    stubFetch([hit, spotifyTrack({ id: "sp-other", name: "Other" })]);
    const out = await searchSpotifyTrack("Radiohead", "Reckoner", envWithCreds());
    expect(out.map((t) => t.id)).toEqual(["sp-reckoner", "sp-other"]);
  });

  it("returns [] on empty items", async () => {
    stubFetch([]);
    expect(await searchSpotifyTrack("Radiohead", "Reckoner", envWithCreds())).toEqual([]);
  });

  it("returns [] and does not throw on a 404 from /search", async () => {
    stubFetch(null);
    await expect(searchSpotifyTrack("Radiohead", "Reckoner", envWithCreds())).resolves.toEqual([]);
  });

  it("sanitizes embedded double-quotes in the field-scoped query (fix 2)", async () => {
    const fn = stubFetch([spotifyTrack()]);
    // A `"Weird Al" Yankovic`-style artist must not throw or malform the query;
    // the stubbed /search must still be reached and return the hit.
    const out = await searchSpotifyTrack('"Weird Al" Yankovic', 'Foil "parody"', envWithCreds());
    expect(out[0]?.id).toBe("sp-reckoner");
    const searchCall = fn.mock.calls.find(([input]) => String(input).includes("/v1/search"));
    expect(searchCall).toBeDefined();
    // No raw double-quote should survive inside the q value's field phrases.
    const q = new URL(String(searchCall?.[0])).searchParams.get("q") ?? "";
    expect(q).toBe('artist:"Weird Al Yankovic" track:"Foil parody"');
  });
});

describe("resolveSpotifyId", () => {
  it("stamps spotifyId and widens isrc from a confident match", async () => {
    stubFetch([spotifyTrack()]);
    const out = await resolveSpotifyId(lastfmCandidate(), envWithCreds());
    expect(out.spotifyId).toBe("sp-reckoner");
    expect(out.isrc).toBe("GBAYE0700743"); // trimmed + upper-cased from the hit
  });

  it("leaves spotifyId null on a low-confidence (cover/karaoke) hit", async () => {
    // Same title, but a completely different artist → fuzzy below threshold.
    stubFetch([
      spotifyTrack({
        id: "sp-karaoke",
        name: "Reckoner (Karaoke Version)",
        artists: [{ id: "z", name: "Ameritz Karaoke Standards" }],
      }),
    ]);
    const out = await resolveSpotifyId(lastfmCandidate(), envWithCreds());
    expect(out.spotifyId).toBeNull();
    expect(out.isrc).toBeNull();
  });

  it("rejects a SUFFIX-form cover whose artist contains the original (the bug; fix 1)", async () => {
    // Realistic karaoke artist that CONTAINS "Radiohead" as a suffix. Under the
    // old `useSellers:true` (Sellers substring) scoring this pair scores a
    // perfect 1.0 and mis-resolves; full-string scoring drops it far below 0.9.
    stubFetch([
      spotifyTrack({
        id: "sp-karaoke-suffix",
        name: "Reckoner",
        artists: [{ id: "k", name: "Karaoke - Originally Performed By Radiohead" }],
      }),
    ]);
    const out = await resolveSpotifyId(lastfmCandidate(), envWithCreds());
    expect(out.spotifyId).toBeNull();
    expect(out.isrc).toBeNull();
  });

  it("rejects a same-artist, different-title hit", async () => {
    stubFetch([
      spotifyTrack({
        id: "sp-karma",
        name: "Karma Police",
        artists: [{ id: "a1", name: "Radiohead" }],
      }),
    ]);
    const out = await resolveSpotifyId(lastfmCandidate(), envWithCreds());
    expect(out.spotifyId).toBeNull();
    expect(out.isrc).toBeNull();
  });

  it("rejects a same-title, different-artist (tribute) hit", async () => {
    stubFetch([
      spotifyTrack({
        id: "sp-tribute",
        name: "Reckoner",
        artists: [{ id: "t", name: "Some Tribute Band" }],
      }),
    ]);
    const out = await resolveSpotifyId(lastfmCandidate(), envWithCreds());
    expect(out.spotifyId).toBeNull();
    expect(out.isrc).toBeNull();
  });

  it("stamps a dash-suffixed remaster of the same recording (LAB-62)", async () => {
    // The live failure case: Spotify's only/top hit for a classic-catalog
    // track carries a " - YYYY Remaster" suffix. Same recording → must stamp.
    stubFetch([spotifyTrack({ id: "sp-remaster", name: "Reckoner - 2016 Remaster" })]);
    const out = await resolveSpotifyId(lastfmCandidate(), envWithCreds());
    expect(out.spotifyId).toBe("sp-remaster");
  });

  it("does NOT stamp a dash-suffixed live take (different recording)", async () => {
    stubFetch([spotifyTrack({ id: "sp-live", name: "Reckoner - Live at Glastonbury" })]);
    const out = await resolveSpotifyId(lastfmCandidate(), envWithCreds());
    expect(out.spotifyId).toBeNull();
  });

  it("picks the best-scoring hit when Spotify ranks a wrong version first (LAB-62)", async () => {
    // Spotify relevance order puts a karaoke cover on top; the genuine track
    // sits second. Best-of-N scoring must stamp the genuine one.
    stubFetch([
      spotifyTrack({
        id: "sp-karaoke",
        name: "Reckoner",
        artists: [{ id: "z", name: "Ameritz Karaoke Standards" }],
      }),
      spotifyTrack(),
    ]);
    const out = await resolveSpotifyId(lastfmCandidate(), envWithCreds());
    expect(out.spotifyId).toBe("sp-reckoner");
  });

  it("does not overwrite an already-set isrc with the hit's isrc", async () => {
    stubFetch([spotifyTrack()]);
    const out = await resolveSpotifyId(
      lastfmCandidate({ isrc: "EXISTING-ISRC-1" }),
      envWithCreds(),
    );
    expect(out.spotifyId).toBe("sp-reckoner");
    expect(out.isrc).toBe("EXISTING-ISRC-1");
  });

  it("skips (no fetch) when the candidate already has a spotifyId", async () => {
    const fn = stubFetch([spotifyTrack()]);
    const input = lastfmCandidate({ spotifyId: "already-here" });
    const out = await resolveSpotifyId(input, envWithCreds());
    expect(out).toBe(input);
    expect(fn).not.toHaveBeenCalled();
  });

  it("skips (no fetch) when the candidate source is spotify", async () => {
    const fn = stubFetch([spotifyTrack()]);
    const input = lastfmCandidate({ source: "spotify", sourceTrackId: "sp-x" });
    const out = await resolveSpotifyId(input, envWithCreds());
    expect(out).toBe(input);
    expect(fn).not.toHaveBeenCalled();
  });

  it("skips (no fetch) when Spotify creds are absent (Constraint #1)", async () => {
    const fn = stubFetch([spotifyTrack()]);
    const input = lastfmCandidate();
    const env = envWithCreds({ SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "" });
    const out = await resolveSpotifyId(input, env);
    expect(out).toBe(input);
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns the candidate unchanged when fetch throws (never crashes ingest)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const input = lastfmCandidate();
    const out = await resolveSpotifyId(input, envWithCreds());
    expect(out).toBe(input);
    expect(out.spotifyId).toBeNull();
  });
});
