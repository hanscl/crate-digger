/**
 * LAB-19 — Chartmetric TikTok-feed verification probe.
 *
 * Context: the dedicated Soundcharts TikTok-velocity adapter was retired (no
 * separate vendor); TikTok velocity now rides in via the Chartmetric breakout
 * engine, which pulls `/api/charts/tiktok/tracks` (`weekly_posts`) as one feed
 * at weight 0.9 (see `src/lib/ingestion/chartmetric/config.ts`). This probe
 * confirms that feed is actually LIVE and returning rows, and prints each row's
 * REAL breakout score using the engine's own scoring (`breakout.ts#toBreakout`)
 * — i.e. exactly what the daily pipeline would compute for a TikTok-sourced
 * candidate. It does NOT touch the DB or the surfacing path; it answers one
 * question: "are we ingesting genuine TikTok breakout tracks via Chartmetric?"
 *
 * Surfacing those tracks is a separate, structural problem — see LAB-160.
 *
 * Metered billing: a handful of GET calls (one per date rung until rows land).
 * Never prints the token. Run:
 *   pnpm tsx --env-file-if-exists=.env scripts/lab19-chartmetric-tiktok-probe.ts
 */

import { num, toBreakout } from "@/lib/ingestion/chartmetric/breakout";
import { DATE_LADDER, POOL_ROWS_PER_FEED } from "@/lib/ingestion/chartmetric/config";
import type { BreakoutSignals, ChartRow } from "@/lib/ingestion/chartmetric/types";
import { extractArtist, extractTitle } from "@/lib/ingestion/chartmetric/util";

const BASE = "https://api.chartmetric.com";
const REFRESH = process.env.CHARTMETRIC_REFRESH_TOKEN ?? "";

if (REFRESH.length === 0) {
  console.error("CHARTMETRIC_REFRESH_TOKEN not set — aborting.");
  process.exit(1);
}

let TOKEN = "";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isoDaysAgo = (d: number): string =>
  new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Walk the Chartmetric envelope to the row array (matches the engine's client). */
function rows(json: unknown): ChartRow[] {
  const root = isRecord(json) ? json : {};
  const obj = root.obj;
  const cands: unknown[] = [obj, isRecord(obj) ? obj.data : undefined, root.data, json];
  for (const c of cands) if (Array.isArray(c)) return c.filter(isRecord) as ChartRow[];
  return [];
}

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
  console.log(`=== AUTH POST /api/token -> HTTP ${res.status} | has token: ${!!json.token}`);
  if (!json.token) return false;
  TOKEN = json.token;
  return true;
}

async function getChartRows(date: string): Promise<{ status: number; rows: ChartRow[] }> {
  // Mirrors the tiktok FEED config: /api/charts/tiktok/tracks, weekly, no country_code.
  const res = await fetch(`${BASE}/api/charts/tiktok/tracks?interval=weekly&date=${date}`, {
    headers: { authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  await sleep(350); // gentle pacing; metered billing
  return { status: res.status, rows: rows(json) };
}

/** TikTok-feed signal extraction — identical to `pool.ts#feedSignals('tiktok', …)`. */
function tiktokSignals(e: ChartRow): BreakoutSignals {
  return {
    tiktokPosts: num(e.weekly_posts),
    chartVelocity: num(e.velocity),
    spotifyPopularity: num(e.spotify_popularity),
  };
}

async function main(): Promise<void> {
  if (!(await authenticate())) {
    console.error("Auth failed — token exchange returned no token.");
    process.exit(1);
  }

  // Weekly date ladder (same as the engine): first rung with rows wins.
  let date = "";
  let chartRows: ChartRow[] = [];
  for (const d of DATE_LADDER.weekly) {
    const dateStr = isoDaysAgo(d);
    const { status, rows: r } = await getChartRows(dateStr);
    console.log(`=== /charts/tiktok/tracks?date=${dateStr} -> HTTP ${status} | rows=${r.length}`);
    if (status === 200 && r.length > 0) {
      date = dateStr;
      chartRows = r;
      break;
    }
  }

  if (chartRows.length === 0) {
    console.log("\nNo TikTok chart rows returned on any date rung — feed empty/unreachable.");
    return;
  }

  // Score each row with the engine's REAL breakout scorer, sorted by score desc.
  const scored = chartRows
    .slice(0, POOL_ROWS_PER_FEED)
    .map((e) => {
      const breakout = toBreakout(tiktokSignals(e), "tiktok");
      return {
        artist: extractArtist(e as Record<string, unknown>),
        title: extractTitle(e),
        weeklyPosts: num(e.weekly_posts),
        spotifyPopularity: num(e.spotify_popularity),
        breakout,
      };
    })
    .sort((a, b) => b.breakout.score - a.breakout.score);

  console.log(
    `\n=== TikTok feed LIVE (date=${date}) — ${scored.length} rows, top by breakout score ===`,
  );
  for (const s of scored.slice(0, 20)) {
    const b = s.breakout;
    console.log(
      `  score=${b.score.toFixed(3)} (social=${b.socialMomentum.toFixed(2)} maturity=${b.spotifyMaturity.toFixed(2)}) ` +
        `posts=${s.weeklyPosts ?? "—"} pop=${s.spotifyPopularity ?? "—"}  ${s.artist} — ${s.title}`,
    );
  }
  const obscure = scored.filter((s) => s.breakout.score >= 0.5).length;
  console.log(
    `\n=== ${obscure}/${scored.length} rows score ≥ 0.50 (high social momentum, low Spotify maturity = real crate-digging) ===`,
  );
}

main().catch((e) => {
  console.error("probe threw:", e);
  process.exit(1);
});
