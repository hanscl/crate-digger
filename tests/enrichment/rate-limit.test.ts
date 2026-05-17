import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, fetchWithRetry } from "@/lib/enrichment/rate-limit";

/**
 * Rate-limit module: request spacing + 429/Retry-After handling. All driven
 * by vitest fake timers so the real ~500ms / 5s waits resolve instantly.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createRateLimiter", () => {
  it("spaces scheduled calls at least minIntervalMs apart; first call is immediate", async () => {
    const limiter = createRateLimiter(500);
    const times: number[] = [];
    const runs = [
      limiter.schedule(async () => void times.push(Date.now())),
      limiter.schedule(async () => void times.push(Date.now())),
      limiter.schedule(async () => void times.push(Date.now())),
    ];
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(runs);
    expect(times).toEqual([0, 500, 1000]);
  });

  it("keeps scheduling after a call rejects — the chain survives", async () => {
    const limiter = createRateLimiter(500);
    const failing = limiter.schedule(async () => {
      throw new Error("boom");
    });
    const after = limiter.schedule(async () => "ok");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });
});

describe("fetchWithRetry", () => {
  it("honours Retry-After on 429: a 5s header pauses 5s before the retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": "5" } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const promise = fetchWithRetry("https://api.reccobeats.com/v1/audio-features?ids=x");

    // 1ms short of the Retry-After window — the retry must not have fired.
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const res = await promise;
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Every 429 is logged so undocumented throttle behaviour can be tuned.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null after retries are exhausted, using exponential backoff", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const promise = fetchWithRetry(
      "https://api.reccobeats.com/v1/audio-features?ids=x",
      {},
      { maxRetries: 2, baseBackoffMs: 1000 },
    );
    // backoff 1000 (2^0) + 2000 (2^1) = 3000ms across attempts 0 and 1.
    await vi.advanceTimersByTimeAsync(3000);
    expect(await promise).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns null on a non-429 error status without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await fetchWithRetry("https://api.reccobeats.com/v1/audio-features?ids=x")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when fetch itself rejects (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await fetchWithRetry("https://api.reccobeats.com/v1/audio-features?ids=x")).toBeNull();
  });

  it("passes a 200 response straight through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const res = await fetchWithRetry("https://api.reccobeats.com/v1/audio-features?ids=x");
    expect(res?.status).toBe(200);
  });
});
