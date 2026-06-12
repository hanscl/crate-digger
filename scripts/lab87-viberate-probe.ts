/**
 * LAB-87 spike — characterize the Viberate API as an ingestion source.
 *
 * Read-only probe against the LIVE API (needs VIBERATE_API_KEY in env). Run:
 *   pnpm tsx --env-file-if-exists=.env scripts/lab87-viberate-probe.ts
 *
 * Confirms (1) auth via the `Access-Key` header, (2) the rate-limit budget, and
 * (3) that `/track/trending/spotify/country` + `/track/search` return ingestible
 * track candidates — title + artist + ISRC, plus a Spotify `track_id` on
 * trending (→ ReccoBeats audio features). Findings recorded in docs/SOURCES.md
 * and on LAB-88. The key is never printed.
 */

const KEY = process.env.VIBERATE_API_KEY ?? "";
if (KEY.length === 0) {
  console.error("VIBERATE_API_KEY is not set (add it to .env)");
  process.exit(1);
}

const BASE = "https://data.viberate.com/api/v1";
const reqHeaders = { "Access-Key": KEY, Accept: "application/json" };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { headers: reqHeaders });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = "<non-JSON>";
  }
  return { status: res.status, body };
}

function dataArray(body: unknown): Record<string, unknown>[] {
  return isObj(body) && Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
}

async function main(): Promise<void> {
  // 1. auth + quota
  const rl = await get("/rate-limit/status");
  console.log(`[auth] GET /rate-limit/status -> HTTP ${rl.status}`);
  console.log(`       ${JSON.stringify(isObj(rl.body) ? rl.body.data : rl.body)}`);
  if (rl.status !== 200) {
    console.error("Auth failed — the key did not authorize. Spike FAILS.");
    process.exit(1);
  }

  // 2. trending (the discovery signal the adapter ships)
  const tr = await get(
    "/track/trending/spotify/country?country=US&sort=streams_1d_pct&order=desc&offset=0&limit=5",
  );
  const trData = dataArray(tr.body);
  console.log(
    `\n[trending] GET /track/trending/spotify/country -> HTTP ${tr.status}, ${trData.length} rows`,
  );
  for (const row of trData) {
    const artists = Array.isArray(row.artists)
      ? (row.artists as Record<string, unknown>[]).map((a) => a.name).join(", ")
      : "";
    console.log(
      `  - ${row.title} — ${artists} | spotify=${row.track_id} isrc=${row.isrc} d%=${row.streams_1d_pct}`,
    );
  }

  // 3. search (genre-rich shape; not shipped in the adapter but documents the API)
  const se = await get("/track/search?q=Levitating&limit=2");
  const seData = dataArray(se.body);
  console.log(`\n[search] GET /track/search -> HTTP ${se.status}, ${seData.length} rows`);
  for (const row of seData) {
    const genre = isObj(row.genre) ? row.genre.name : null;
    const subs = Array.isArray(row.subgenres)
      ? (row.subgenres as Record<string, unknown>[]).map((s) => s.name).join("/")
      : "";
    console.log(`  - ${row.name} | isrc=${row.isrc} genre=${genre} subgenres=${subs}`);
  }

  const ingestible =
    trData.length > 0 && trData.every((r) => typeof r.title === "string" && r.title && r.isrc);
  console.log(
    `\n[verdict] trending yields ingestible candidates (title+isrc+spotify_id): ${
      ingestible ? "YES — spike PASSES" : "NO"
    }`,
  );
}

main().catch((err: unknown) => {
  console.error("probe failed:", err);
  process.exitCode = 1;
});
