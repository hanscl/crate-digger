import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetChartmetricTokenCache, type ChartmetricVelocity } from "@/lib/ingestion/chartmetric";
import { tiktokAdapter } from "@/lib/ingestion/tiktok";
import type { Env } from "@/server/env";

/**
 * Round-trip test for the TikTok adapter via its DEFAULT provider, Chartmetric.
 *
 * ⚠️ Chartmetric has no open sandbox, so these fixtures model the documented
 * shape, not a live response. The test pins the adapter's defensive parsing
 * (envelope + field extraction) and the refresh-token → bearer flow; the field
 * NAMES are verified against the live API post-merge (see the provider's note).
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
    CHARTMETRIC_REFRESH_TOKEN: "refresh-token",
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

const CHART = {
  obj: [
    {
      id: 111,
      name: "Viral Smash",
      artist_names: ["Nova", "Guest MC"],
      isrc: "usabc1234567",
      rank: 1,
      pre_rank: 4,
      spotify_track_id: "spfy111",
    },
    {
      // no isrc; title via `track_title`; artist via `artists: [{name}]`
      cm_track: 222,
      track_title: "Sleeper Hit",
      artists: [{ name: "The Quiet" }],
      rank: 2,
    },
    {
      // unresolvable — no title — must be dropped
      artist_names: ["Ghost"],
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Mock the token exchange + the TikTok chart GET. */
function stubChartmetric() {
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/token")) return jsonResponse({ token: "access-abc", expires_in: 3600 });
    if (url.includes("/charts/tiktok")) {
      // assert auth on the data call by surfacing it through the mock record
      void init;
      return jsonResponse(CHART);
    }
    return new Response("unexpected", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  _resetChartmetricTokenCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tiktok adapter (Chartmetric, default provider)", () => {
  it("is available with a refresh token; unavailable (and paid) without one", () => {
    expect(tiktokAdapter.isAvailable(makeEnv())).toBe(true);
    // No Chartmetric token AND no Soundcharts creds (both empty in makeEnv) ⇒ unavailable.
    expect(tiktokAdapter.isAvailable(makeEnv({ CHARTMETRIC_REFRESH_TOKEN: "" }))).toBe(false);
    expect(tiktokAdapter.isPaid).toBe(true);
  });

  it("takes precedence over Soundcharts when BOTH providers are configured", async () => {
    // Both vendors have credentials; Chartmetric is first in PROVIDERS so it must
    // win — proven by Chartmetric's token exchange firing while Soundcharts's
    // chart endpoint is never touched.
    const mock = stubChartmetric();
    await tiktokAdapter.pullCandidates(
      { mode: "trending", limit: 5 },
      makeEnv({ SOUNDCHARTS_APP_ID: "app", SOUNDCHARTS_API_KEY: "key" }),
    );
    const urls = mock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/token"))).toBe(true); // Chartmetric selected
    expect(urls.some((u) => u.includes("/ranking/latest"))).toBe(false); // Soundcharts untouched
  });

  it("exchanges the refresh token, then pulls the chart with a bearer token", async () => {
    const mock = stubChartmetric();
    await tiktokAdapter.pullCandidates({ mode: "trending", limit: 5 }, makeEnv());

    const tokenCall = mock.mock.calls.find((c) => String(c[0]).includes("/api/token"));
    if (!tokenCall) throw new Error("expected a token exchange call");
    const tokenBody = JSON.parse(String((tokenCall[1] as RequestInit).body));
    expect(tokenBody).toMatchObject({ refreshtoken: "refresh-token" });

    const chartCall = mock.mock.calls.find((c) => String(c[0]).includes("/charts/tiktok"));
    const chartUrl = String(chartCall?.[0]);
    expect(chartUrl).toContain("type=tracks");
    expect(chartUrl).toContain("interval=weekly");
    expect(chartUrl).toContain("country_code=US");
    expect((chartCall?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      authorization: "Bearer access-abc",
    });
  });

  it("maps chart entries into candidates with ISRC, artist + velocity, dropping titleless rows", async () => {
    stubChartmetric();
    const out = await tiktokAdapter.pullCandidates({ mode: "trending", limit: 5 }, makeEnv());

    expect(out).toHaveLength(2); // the titleless third row is dropped
    const top = out[0];
    if (!top) throw new Error("expected a charted candidate");
    expect(top).toMatchObject({
      source: "tiktok",
      sourceTrackId: "111",
      isrc: "USABC1234567",
      spotifyId: "spfy111",
      title: "Viral Smash",
      artist: "Nova, Guest MC", // artist_names array joined
    });
    const velocity = (top.rawPayload as { velocity: ChartmetricVelocity }).velocity;
    expect(velocity).toMatchObject({ provider: "chartmetric", country: "US", rank: 1, preRank: 4 });

    const second = out[1];
    expect(second).toMatchObject({
      sourceTrackId: "222", // cm_track
      isrc: null,
      artist: "The Quiet", // artists: [{name}]
      title: "Sleeper Hit", // track_title
      spotifyId: null,
    });
  });

  it("caches the access token across pulls (one token exchange for two pulls)", async () => {
    const mock = stubChartmetric();
    await tiktokAdapter.pullCandidates({ mode: "trending", limit: 5 }, makeEnv());
    await tiktokAdapter.pullCandidates({ mode: "trending", limit: 5 }, makeEnv());
    const tokenCalls = mock.mock.calls.filter((c) => String(c[0]).includes("/api/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("honours a configured country", async () => {
    const mock = stubChartmetric();
    await tiktokAdapter.pullCandidates(
      { mode: "trending", limit: 5 },
      makeEnv({ CHARTMETRIC_TIKTOK_COUNTRY: "GB" }),
    );
    const chartCall = mock.mock.calls.find((c) => String(c[0]).includes("/charts/tiktok"));
    expect(String(chartCall?.[0])).toContain("country_code=GB");
  });
});
