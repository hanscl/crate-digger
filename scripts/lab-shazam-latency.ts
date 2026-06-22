/**
 * Shazam latency-distribution follow-up.
 *
 * The first spike showed Shazam returns HTTP 200 (200 rows) but with spiky
 * latency: same params ranged 273ms .. 10392ms across dates, and a date that was
 * fast for us (06-21 @ 1.2s) had TIMED OUT in production. This characterises the
 * spread to answer:
 *   - Is it cold-cache warming? (1st hit on a date slow, repeats fast)
 *   - Or per-call random? (no warm-up effect)
 * The answer decides the fix (longer timeout vs. retry-warms-cache vs. neither).
 *
 *   pnpm tsx --env-file-if-exists=.env scripts/lab-shazam-latency.ts
 */

export {}; // module scope

const BASE = "https://api.chartmetric.com";
const REFRESH = process.env.CHARTMETRIC_REFRESH_TOKEN ?? "";
const COUNTRY = process.env.CHARTMETRIC_TRENDING_COUNTRY ?? "US";
const TIMEOUT_MS = 45_000;
const REPEATS = 6;

if (REFRESH.length === 0) {
  console.error("CHARTMETRIC_REFRESH_TOKEN not set — aborting.");
  process.exit(1);
}

let TOKEN = "";
const isoDaysAgo = (d: number): string =>
  new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function authenticate(): Promise<boolean> {
  const res = await fetch(`${BASE}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshtoken: REFRESH }),
  });
  let json: { token?: string } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* ignore */
  }
  if (!json.token) return false;
  TOKEN = json.token;
  return true;
}

/** Timed GET, returns latency ms (or -1 on abort/throw) + status. */
async function timed(path: string): Promise<{ ms: number; status: number | "ABORT" }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
      signal: controller.signal,
    });
    await res.arrayBuffer(); // drain body so timing includes full transfer
    return { ms: Date.now() - t0, status: res.status };
  } catch {
    return { ms: Date.now() - t0, status: "ABORT" };
  } finally {
    clearTimeout(timer);
  }
}

function stats(xs: number[]): string {
  const ok = xs.filter((x) => x >= 0);
  if (ok.length === 0) return "no successes";
  const sorted = [...ok].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const med = sorted[Math.floor(sorted.length / 2)]!;
  const over8 = ok.filter((x) => x > 8000).length;
  return `min=${min}ms med=${med}ms max=${max}ms  >8s: ${over8}/${ok.length}`;
}

async function main(): Promise<void> {
  if (!(await authenticate())) {
    console.error("Auth failed.");
    process.exit(1);
  }
  console.log(`country=${COUNTRY}  repeats=${REPEATS}  now=${new Date().toISOString()}\n`);

  for (const d of [1, 2, 4]) {
    const date = isoDaysAgo(d);
    const path = `/api/charts/shazam?country_code=${COUNTRY}&date=${date}`;
    const all: number[] = [];
    const line: string[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const r = await timed(path);
      all.push(r.status === "ABORT" ? 8001 : r.ms); // count abort as >8s
      line.push(r.status === "ABORT" ? "ABORT" : `${r.ms}ms(${r.status})`);
      await sleep(400);
    }
    console.log(`shazam d-${d} (${date}):`);
    console.log(`   calls: ${line.join("  ")}`);
    console.log(`   ${stats(all)}\n`);
  }

  console.log("=== DONE ===");
}

main().catch((e) => {
  console.error("threw:", e);
  process.exit(1);
});
