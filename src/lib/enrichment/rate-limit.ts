/**
 * Request pacing + 429-aware retry for the ReccoBeats enrichment path.
 *
 * ReccoBeats publishes no rate-limit numbers. Community field practice
 * (Lewis Quayle, Nov 2025) settled on ~2 req/s after being throttled with
 * no warning — so we pace at 2 req/s and honour `Retry-After` on 429.
 *
 * Hand-rolled on purpose: a single endpoint with a fixed spec does not
 * justify a `bottleneck`-class dependency, and the codebase carries no
 * rate-limit library today.
 */

/** Resolves after `ms`. Uses `setTimeout` so vitest fake timers can drive it. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RateLimiter = {
  /** Run `fn` no sooner than `minIntervalMs` after the previous scheduled call started. */
  schedule<T>(fn: () => Promise<T>): Promise<T>;
};

/**
 * Serializing request-spacing limiter. Scheduled calls run one at a time,
 * each starting at least `minIntervalMs` after the previous one — a 2 req/s
 * cap at the 500ms default. Concurrent callers queue in arrival order.
 */
export function createRateLimiter(minIntervalMs = 500): RateLimiter {
  let tail: Promise<unknown> = Promise.resolve();
  // -Infinity so the first scheduled call never waits.
  let lastStart = Number.NEGATIVE_INFINITY;
  return {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(async () => {
        const wait = lastStart + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastStart = Date.now();
        return fn();
      });
      // The chain must survive a rejected `fn` — swallow the rejection for
      // the tail only; the `run` promise still rejects for the caller.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1_000;

export type FetchWithRetryOptions = {
  maxRetries?: number;
  baseBackoffMs?: number;
  timeoutMs?: number;
};

/**
 * `fetch` with a per-attempt timeout and 429 handling. On 429 it honours the
 * `Retry-After` header (delay-seconds), falling back to exponential backoff,
 * logs every 429 with the response headers so throttle behaviour can be
 * tuned later, and retries up to `maxRetries`. Any other non-OK status or a
 * network throw resolves to `null` — callers degrade gracefully rather than
 * crash the pipeline (mirrors `spotifyGet`).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchWithRetryOptions = {},
): Promise<Response | null> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoff = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      console.error(`[reccobeats] fetch threw for ${url}`, err);
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const backoff = retryAfterMs ?? baseBackoff * 2 ** attempt;
      const exhausted = attempt >= maxRetries;
      // Log every 429 with the headers — undocumented limits, so the only
      // way to tune later is to see what the server actually returns.
      console.warn(
        `[reccobeats] 429 rate-limited (attempt ${attempt + 1}/${maxRetries + 1}); ` +
          (exhausted ? "retries exhausted" : `backing off ${backoff}ms`),
        Object.fromEntries(res.headers.entries()),
      );
      if (exhausted) return null;
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      console.error(`[reccobeats] ${url} ${res.status}`);
      return null;
    }
    return res;
  }
  return null;
}

/** Parse a `Retry-After` header (delay-seconds form) to ms; null if absent/invalid. */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // The HTTP-date form is spec-legal but ReccoBeats uses delay-seconds; if a
  // date ever shows up, fall back to the caller's exponential backoff.
  return null;
}
