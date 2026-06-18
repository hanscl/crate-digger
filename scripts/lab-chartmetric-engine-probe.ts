/**
 * Chartmetric discovery-engine spike probe (LAB — Chartmetric vs Viberate).
 *
 * The prior Chartmetric integration (the retired LAB-19 TikTok provider) was
 * modelled from docs and never verified live. This probe verified the live
 * shapes the LAB-117 social-breakout discovery engine
 * (src/lib/ingestion/chartmetric/) is built on — the same questions the Viberate
 * engine answered in lab-viberate-engine-probe:
 *
 *   0. Auth — refresh-token -> bearer exchange (POST /api/token).
 *   1. Multi-platform CHART feeds (the breakout pool): spotify / tiktok /
 *      shazam / soundcloud / youtube / applemusic. Which exist, what params
 *      they take, and what a row carries (rank, prev-rank, ids, ISRC inline?).
 *   2. ISRC -> ids resolution (/track/isrc/{isrc}/get-ids).
 *   3. Per-track CROSS-PLATFORM stats: is the breakout gap (social momentum vs
 *      Spotify maturity) computable inline, or only via N per-track calls?
 *      (This is the architecture-deciding question — the Viberate composite
 *      chart gave us the gap inline; does Chartmetric?)
 *
 * Metered billing: every call costs ~a credit, so the probe is deliberately
 * lean (limit=5, early-exit on the first working param variant). Never prints
 * the token. Run:
 *   pnpm tsx --env-file-if-exists=.env scripts/lab-chartmetric-engine-probe.ts
 */

export {}; // module scope

const BASE = "https://api.chartmetric.com";
const REFRESH = process.env.CHARTMETRIC_REFRESH_TOKEN ?? "";

if (REFRESH.length === 0) {
  console.error("CHARTMETRIC_REFRESH_TOKEN not set — aborting.");
  process.exit(1);
}

let TOKEN = "";
let callCount = 0;

type GetResult = { status: number; ok: boolean; json: unknown };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isoDaysAgo = (d: number): string =>
  new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

async function authenticate(): Promise<boolean> {
  const res = await fetch(`${BASE}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshtoken: REFRESH }),
  });
  let json: { token?: string; expires_in?: number; scope?: string } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* ignore */
  }
  console.log(
    `=== 0. AUTH POST /api/token -> HTTP ${res.status} | has token: ${!!json.token} | expires_in: ${json.expires_in ?? "?"} | scope: ${json.scope ?? "(none)"}`,
  );
  if (!json.token) return false;
  TOKEN = json.token;
  return true;
}

async function get(path: string): Promise<GetResult> {
  callCount += 1;
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  await sleep(350); // gentle pacing; metered billing
  return { status: res.status, ok: res.ok, json };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Walk the Chartmetric envelope ({obj:[…]} | {obj:{data:[…]}} | {data:[…]} | bare) to the row array. */
function rows(json: unknown): Record<string, unknown>[] {
  const root = isRecord(json) ? json : {};
  const obj = root.obj;
  const cands: unknown[] = [obj, isRecord(obj) ? obj.data : undefined, root.data, json];
  for (const c of cands) if (Array.isArray(c)) return c.filter(isRecord);
  return [];
}

/** Unwrap a single-object Chartmetric response. */
function objOf(json: unknown): unknown {
  const root = isRecord(json) ? json : {};
  return root.obj ?? root.data ?? json;
}

function keysOf(obj: unknown): string {
  return obj && typeof obj === "object" ? Object.keys(obj as object).join(", ") : "(not an object)";
}

function preview(obj: unknown, n = 900): string {
  return JSON.stringify(obj, null, 2).slice(0, n);
}

function firstStr(e: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = e[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Report the breakout-relevant fields extracted from a chart row. */
function reportRow(label: string, e: Record<string, unknown>): void {
  const id = firstStr(e, ["id"]);
  const cmTrack = firstStr(e, ["cm_track"]);
  const sp = firstStr(e, ["spotify_track_id", "spotify_id"]);
  const isrc = firstStr(e, ["isrc"]) ?? (Array.isArray(e.isrcs) ? String(e.isrcs[0]) : null);
  const name = firstStr(e, ["name", "track_title", "title", "track_name"]);
  const rank = firstStr(e, ["rank", "position"]);
  const preRank = firstStr(e, ["pre_rank", "prev_rank", "previous_rank"]);
  const velocity = firstStr(e, ["velocity"]);
  console.log(
    `   [${label}] name=${JSON.stringify(name)} id=${id} cm_track=${cmTrack} spotify=${sp} ISRC=${isrc ?? "—"} rank=${rank} preRank=${preRank} velocity=${velocity}`,
  );
}

/** Probe one chart: try param variants, stop at the first 200-with-rows; report shape. */
async function probeChart(
  platform: string,
  variants: string[],
): Promise<Record<string, unknown> | null> {
  console.log(`\n=== CHART: ${platform} ===`);
  for (const qs of variants) {
    const path = `/api/charts/${platform}?${qs}`;
    const res = await get(path);
    const rs = rows(res.json);
    console.log(`   try ?${qs} -> HTTP ${res.status} | rows=${rs.length}`);
    if (res.status === 200 && rs.length > 0) {
      const first = rs[0]!;
      console.log(`   first row keys: ${keysOf(first)}`);
      reportRow("row0", first);
      return first;
    }
    if (res.status !== 200) {
      console.log(`   err preview: ${preview(res.json, 220)}`);
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!(await authenticate())) {
    console.error("Auth failed — aborting (token exchange returned no token).");
    process.exit(1);
  }

  const D2 = isoDaysAgo(2);
  const D4 = isoDaysAgo(4);
  const D8 = isoDaysAgo(8);

  // 1. Multi-platform chart feeds (the pool). Charts reject limit/offset and
  //    require interval/country_code/date — corrected from the v1 probe's
  //    validation errors. We slice client-side. tiktok/youtube/applemusic 404 at
  //    /api/charts/{platform}, so try sub-paths.
  const firstRows: Record<string, Record<string, unknown> | null> = {};
  firstRows.spotify = await probeChart("spotify", [
    `type=regional&country_code=US&interval=daily&date=${D2}`,
    `type=regional&country_code=US&interval=daily&date=${D4}`,
    `type=viral&country_code=US&interval=daily&date=${D2}`,
  ]);
  firstRows.shazam = await probeChart("shazam", [
    `country_code=US&interval=daily&date=${D2}`,
    `country_code=US&date=${D2}`,
    `country_code=US&interval=weekly&date=${D4}`,
  ]);
  firstRows.soundcloud = await probeChart("soundcloud", [
    `country_code=US&kind=trending&genre=all&interval=weekly&date=${D8}`,
    `kind=trending&genre=all&interval=weekly&date=${D8}`,
    `country_code=US&kind=top&genre=all&interval=weekly&date=${D8}`,
  ]);
  firstRows.tiktok = await probeChart("tiktok/tracks", [`interval=weekly&date=${D8}`]);
  firstRows.youtube = await probeChart("youtube/tracks", [
    `country_code=US&date=${D2}`,
    `type=tracks&country_code=US&date=${D2}`,
  ]);
  firstRows.applemusic = await probeChart("applemusic/tracks", [
    `type=daily&country_code=us&date=${D2}`,
    `type=top&country_code=us&date=${D2}`,
  ]);

  // 2. Pick the canonical track id (cm_track) + an ISRC seen on any chart row.
  //    NB: the chart row's `id` ≠ `cm_track`; per-track endpoints key on cm_track.
  let cmTrack: string | null = null;
  let isrc: string | null = null;
  for (const r of Object.values(firstRows)) {
    if (!r) continue;
    cmTrack ??= firstStr(r, ["cm_track"]);
    isrc ??= firstStr(r, ["isrc"]) ?? (Array.isArray(r.isrcs) ? String(r.isrcs[0]) : null);
  }
  console.log(`\n=== 2. RESOLUTION seeds: cm_track=${cmTrack ?? "—"} isrc=${isrc ?? "—"} ===`);

  let canonId: string | null = null;
  if (isrc) {
    const r = await get(`/api/track/isrc/${encodeURIComponent(isrc)}/get-ids`);
    console.log(
      `   /track/isrc/${isrc}/get-ids -> HTTP ${r.status}: ${preview(objOf(r.json), 420)}`,
    );
    const o = objOf(r.json);
    const arr = Array.isArray(o) ? o : [o];
    const first = (arr[0] ?? {}) as Record<string, unknown>;
    canonId = Array.isArray(first.chartmetric_ids) ? String(first.chartmetric_ids[0]) : null;
  } else {
    console.log("   (no ISRC on any chart row)");
  }

  // 3. Per-track METADATA — the one optional resolve hop. Dump cm_statistics:
  //    if it carries Spotify streams / playlist reach, ONE call gives genres +
  //    maturity for a social-chart breakout track (the Viberate resolve pattern).
  const id = canonId ?? cmTrack;
  console.log(`\n=== 3. PER-TRACK metadata for id=${id ?? "(none)"} ===`);
  if (id) {
    const r = await get(`/api/track/${id}`);
    const o = objOf(r.json) as Record<string, unknown>;
    console.log(`   /api/track/${id} -> HTTP ${r.status} | keys: ${keysOf(o)}`);
    if (r.ok) {
      console.log(`   genres: ${preview((o as { genres?: unknown }).genres, 200)}`);
      console.log(
        `   track_tier=${JSON.stringify(o.track_tier)} track_stage=${JSON.stringify(o.track_stage)} career_health=${JSON.stringify(o.career_health)}`,
      );
      console.log(
        `   cm_statistics: ${preview((o as { cm_statistics?: unknown }).cm_statistics, 800)}`,
      );
    }
  }

  console.log(`\n=== DONE — ${callCount} billed GET calls (+1 token POST) ===`);
}

main().catch((e) => {
  console.error("probe threw:", e);
  process.exit(1);
});
