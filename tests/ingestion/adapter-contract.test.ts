import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetChartmetricTokenCache } from "@/lib/ingestion/chartmetric/client";
import { _resetSpotifyTokenCache } from "@/lib/ingestion/spotify";
import { allAdapters } from "@/lib/ingestion";
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

const credsByAdapter: Record<string, Partial<Env>> = {
  spotify: { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" },
  lastfm: { LASTFM_API_KEY: "key" },
  viberate: { VIBERATE_API_KEY: "key" },
  chartmetric: { CHARTMETRIC_REFRESH_TOKEN: "refresh-token" },
  // Soundcharts is now the TikTok adapter's only provider (Chartmetric → LAB-117).
  tiktok: { SOUNDCHARTS_APP_ID: "app", SOUNDCHARTS_API_KEY: "key" },
};

beforeEach(() => {
  // Fake timers so adapters that PACE their calls through a rate limiter (e.g.
  // the multi-feed Viberate engine) don't blow the 5s timeout on real-time
  // sleeps; tests advance fake time to drive the limiter/backoff to completion.
  vi.useFakeTimers();
  _resetSpotifyTokenCache();
  _resetChartmetricTokenCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Drive a paced adapter call to completion under fake timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(120_000);
  return await p;
}

describe("source adapter contract", () => {
  it("registers at least the documented adapters", () => {
    const ids = allAdapters.map((a) => a.id).sort();
    expect(ids).toEqual(["chartmetric", "lastfm", "spotify", "tiktok", "viberate"]);
  });

  for (const adapter of allAdapters) {
    describe(`adapter: ${adapter.id}`, () => {
      it("implements the SourceAdapter shape", () => {
        expect(typeof adapter.id).toBe("string");
        expect(typeof adapter.isPaid).toBe("boolean");
        expect(typeof adapter.isAvailable).toBe("function");
        expect(typeof adapter.pullCandidates).toBe("function");
      });

      it("reports unavailable without credentials", () => {
        expect(adapter.isAvailable(makeEnv())).toBe(false);
      });

      it("returns an empty pool without credentials (graceful degrade)", async () => {
        const out = await settle(
          adapter.pullCandidates({ mode: "trending", limit: 10 }, makeEnv()),
        );
        expect(out).toEqual([]);
      });

      it("does not throw when the upstream errors", async () => {
        const env = makeEnv(credsByAdapter[adapter.id]);
        // Spotify hits the token endpoint first; both adapters then hit their API.
        // A 500 from any of those must NOT bubble up.
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response("upstream blew up", {
                status: 500,
                statusText: "Internal Server Error",
              }),
          ),
        );
        await expect(
          settle(adapter.pullCandidates({ mode: "trending", limit: 5 }, env)),
        ).resolves.toEqual([]);
      });

      it("does not throw when fetch itself rejects (network error)", async () => {
        const env = makeEnv(credsByAdapter[adapter.id]);
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new TypeError("network down");
          }),
        );
        await expect(
          settle(adapter.pullCandidates({ mode: "search", query: "test", limit: 5 }, env)),
        ).resolves.toEqual([]);
      });
    });
  }
});
