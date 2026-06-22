/**
 * Shazam-endpoint timeout spike.
 *
 * Production runs see every `/api/charts/shazam` call abort at the 8s
 * fetchWithRetry timeout (4 attempts × 4 date rungs), dropping the weight-1.0
 * breakout feed and burning ~40–156s of wall-clock per pipeline run. This probe
 * answers: is Shazam slow-but-alive (>8s, would succeed with a longer timeout)
 * or genuinely hung/broken? Is it Shazam-specific (the other feeds are a control
 * group)? Does a param variant or a different date behave differently?
 *
 * Uses a GENEROUS 45s timeout and measures wall-clock latency per call so we can
 * see whether a response ever arrives and how long it takes. Mirrors production
 * params exactly (country_code + date, NO interval — LAB-118 found Shazam rejects
 * interval). Metered billing, so kept lean.
 *
 *   pnpm tsx --env-file-if-exists=.env scripts/lab-shazam-spike.ts
 */

export {}; // module scope

const BASE = "https://api.chartmetric.com";
const REFRESH = process.env.CHARTMETRIC_REFRESH_TOKEN ?? "";
const COUNTRY = process.env.CHARTMETRIC_TRENDING_COUNTRY ?? "US";
const TIMEOUT_MS = 45_000; // generous — we WANT to see slow responses land

if (REFRESH.length === 0) {
  console.error("CHARTMETRIC_REFRESH_TOKEN not set — aborting.");
  process.exit(1);
}

let TOKEN = "";

const isoDaysAgo = (d: number): string =>
  new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Walk the Chartmetric envelope to the row array. */
function rows(json: unknown): Record<string, unknown>[] {
  const root = isRecord(json) ? json : {};
  const obj = root.obj;
  const cands: unknown[] = [obj, isRecord(obj) ? obj.data : undefined, root.data, json];
  for (const c of cands) if (Array.isArray(c)) return c.filter(isRecord);
  return [];
}

function preview(obj: unknown, n = 300): string {
  return JSON.stringify(obj).slice(0, n);
}

type Timed = {
  status: number | "THREW";
  ms: number;
  rows: number;
  err?: string;
  body?: unknown;
};

/** One timed GET with an explicit AbortController timeout. */
async function timedGet(path: string, timeoutMs = TIMEOUT_MS): Promise<Timed> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const ms = Date.now() - t0;
    return {
      status: res.status,
      ms,
      rows: rows(json).length,
      body: res.ok ? undefined : json,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    const e = err as Error;
    return { status: "THREW", ms, rows: 0, err: `${e.name}: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function authenticate(): Promise<boolean> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshtoken: REFRESH }),
  });
  let json: { token?: string; expires_in?: number } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* ignore */
  }
  console.log(
    `=== AUTH POST /api/token -> HTTP ${res.status} in ${Date.now() - t0}ms | has token: ${!!json.token}`,
  );
  if (!json.token) return false;
  TOKEN = json.token;
  return true;
}

function fmt(label: string, t: Timed): string {
  const head = `${label.padEnd(46)} -> ${String(t.status).padEnd(6)} ${String(t.ms).padStart(7)}ms  rows=${t.rows}`;
  if (t.err) return `${head}  ${t.err}`;
  if (t.body !== undefined) return `${head}  body=${preview(t.body, 200)}`;
  return head;
}

async function main(): Promise<void> {
  if (!(await authenticate())) {
    console.error("Auth failed — aborting.");
    process.exit(1);
  }
  console.log(`country=${COUNTRY}  timeout=${TIMEOUT_MS}ms  now=${new Date().toISOString()}\n`);

  // 1. SHAZAM — production-exact params, full daily date ladder [1,2,3,4].
  console.log("=== 1. SHAZAM (production params: country_code + date, no interval) ===");
  for (const d of [1, 2, 3, 4]) {
    const date = isoDaysAgo(d);
    const t = await timedGet(`/api/charts/shazam?country_code=${COUNTRY}&date=${date}`);
    console.log(fmt(`shazam d-${d} (${date})`, t));
  }

  // 2. SHAZAM — does an older date / a no-country / a city-id variant behave differently?
  console.log("\n=== 2. SHAZAM variants ===");
  console.log(
    fmt(
      "shazam d-7 (older)",
      await timedGet(`/api/charts/shazam?country_code=${COUNTRY}&date=${isoDaysAgo(7)}`),
    ),
  );
  console.log(fmt("shazam no country", await timedGet(`/api/charts/shazam?date=${isoDaysAgo(2)}`)));
  console.log(
    fmt(
      "shazam +interval=daily (LAB-118 said 400)",
      await timedGet(
        `/api/charts/shazam?country_code=${COUNTRY}&interval=daily&date=${isoDaysAgo(2)}`,
      ),
    ),
  );
  console.log(
    fmt(
      "shazam +city_id=-1",
      await timedGet(`/api/charts/shazam?country_code=${COUNTRY}&city_id=-1&date=${isoDaysAgo(2)}`),
    ),
  );

  // 3. CONTROL GROUP — the other three production feeds. Confirms whether the
  //    stall is Shazam-specific or account/transport-wide.
  console.log("\n=== 3. CONTROL — other production feeds ===");
  console.log(
    fmt(
      "soundcloud (weekly d-4)",
      await timedGet(
        `/api/charts/soundcloud?country_code=${COUNTRY}&kind=trending&genre=all-music&date=${isoDaysAgo(4)}`,
      ),
    ),
  );
  console.log(
    fmt(
      "tiktok/tracks (weekly d-4)",
      await timedGet(`/api/charts/tiktok/tracks?interval=weekly&date=${isoDaysAgo(4)}`),
    ),
  );
  console.log(
    fmt(
      "spotify regional (daily d-2)",
      await timedGet(
        `/api/charts/spotify?type=regional&country_code=${COUNTRY}&interval=daily&date=${isoDaysAgo(2)}`,
      ),
    ),
  );

  console.log("\n=== DONE ===");
}

main().catch((e) => {
  console.error("spike threw:", e);
  process.exit(1);
});
