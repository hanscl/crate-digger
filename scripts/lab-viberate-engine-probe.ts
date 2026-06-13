/**
 * Viberate discovery-engine spike probe (follow-on to lab87).
 *
 * Verifies the live shapes the breakout engine depends on but the LAB-87 spike
 * never checked:
 *   1. YouTube trending rows + how they RESOLVE (no ISRC / no track uuid in the
 *      row — try every plausible resolution path and report which works).
 *   2. The global Viberate composite chart (sort by shazam / soundcloud).
 *   3. UUID -> ISRC (/details) + UUID -> Spotify id (/links).
 *   4. Per-track social velocity (Shazam / SoundCloud / YouTube) availability on
 *      the FREE /track namespace (TikTok requires metered /requested-track — not
 *      exercised here to avoid consuming registration quota).
 *   5. Spotify-maturity signal (streams / playlists) for the anti-mainstream gap.
 *
 * Never prints the API key. Run:
 *   pnpm tsx --env-file-if-exists=.env scripts/lab-viberate-engine-probe.ts
 */

export {}; // module scope — keep top-level consts out of the global script namespace

const BASE = "https://data.viberate.com/api/v1";
const KEY = process.env.VIBERATE_API_KEY ?? "";

if (KEY.length === 0) {
  console.error("VIBERATE_API_KEY not set — aborting.");
  process.exit(1);
}

type GetResult = { status: number; ok: boolean; json: unknown };

async function get(path: string): Promise<GetResult> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Access-Key": KEY, Accept: "application/json" },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  // gentle pacing — quota is ~60/window
  await new Promise((r) => setTimeout(r, 1100));
  return { status: res.status, ok: res.ok, json };
}

function rows(json: unknown): Record<string, unknown>[] {
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function keysOf(obj: unknown): string {
  return obj && typeof obj === "object" ? Object.keys(obj as object).join(", ") : "(not an object)";
}

function preview(obj: unknown): string {
  return JSON.stringify(obj, null, 2).slice(0, 1200);
}

const isoDaysAgo = (d: number): string =>
  new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

async function main(): Promise<void> {
  console.log("=== 0. rate-limit status ===");
  const rl = await get("/rate-limit/status");
  console.log(`HTTP ${rl.status}`, preview(rl.json));

  console.log("\n=== 1. YouTube trending (US, views_1w_pct desc) ===");
  const yt = await get(
    "/track/trending/youtube/country?country=US&sort=views_1w_pct&order=desc&offset=0&limit=5",
  );
  console.log(`HTTP ${yt.status}`);
  const ytRows = rows(yt.json);
  console.log(`rows: ${ytRows.length}`);
  if (ytRows[0]) {
    console.log("first row keys:", keysOf(ytRows[0]));
    console.log("first row:", preview(ytRows[0]));
  }

  // 2. Try to RESOLVE the first YouTube row to a Viberate track + ISRC/Spotify.
  console.log("\n=== 2. RESOLVE the YouTube row (try every path) ===");
  const r0 = ytRows[0] ?? {};
  const trackId = typeof r0.track_id === "string" ? r0.track_id : "";
  const ytId = typeof r0.youtube_id === "string" ? r0.youtube_id : "";
  const rowUuid = typeof r0.uuid === "string" ? r0.uuid : "";
  console.log(`candidate ids -> track_id="${trackId}" youtube_id="${ytId}" uuid="${rowUuid}"`);

  const tries: { label: string; path: string }[] = [];
  if (rowUuid) tries.push({ label: "details via row.uuid", path: `/track/${rowUuid}/details` });
  if (trackId)
    tries.push({
      label: "details via track_id (G:..)",
      path: `/track/${encodeURIComponent(trackId)}/details`,
    });
  if (trackId)
    tries.push({
      label: "links via track_id (G:..)",
      path: `/track/${encodeURIComponent(trackId)}/links`,
    });
  if (ytId)
    tries.push({
      label: "by-channel youtube/<youtube_id>",
      path: `/track/by-channel/youtube/${ytId}`,
    });
  for (const t of tries) {
    const res = await get(t.path);
    console.log(
      `\n[${t.label}] ${t.path}\n  HTTP ${res.status} -> ${res.ok ? keysOf((res.json as { data?: unknown })?.data ?? res.json) : "FAIL"}`,
    );
    if (res.ok)
      console.log(
        "  preview:",
        preview((res.json as { data?: unknown })?.data ?? res.json).slice(0, 600),
      );
  }

  console.log("\n=== 3. Viberate composite chart (sort=shazam-shazams, timeframe=1w) ===");
  const comp = await get("/track/viberate/chart?sort=shazam-shazams&timeframe=1w&limit=5&offset=0");
  console.log(`HTTP ${comp.status}`);
  const compRows = rows(comp.json);
  console.log(`rows: ${compRows.length}`);
  if (compRows[0]) {
    console.log("first row keys:", keysOf(compRows[0]));
    console.log("first row:", preview(compRows[0]));
  }
  // also soundcloud sort for comparison
  const compSc = await get(
    "/track/viberate/chart?sort=soundcloud-plays&timeframe=1w&limit=3&offset=0",
  );
  console.log(`\n[soundcloud-plays sort] HTTP ${compSc.status} rows=${rows(compSc.json).length}`);
  if (rows(compSc.json)[0]) console.log("first:", preview(rows(compSc.json)[0]).slice(0, 500));

  // 4. Resolve a composite uuid -> isrc + spotify id, then pull social velocity.
  const uuid = typeof compRows[0]?.uuid === "string" ? (compRows[0].uuid as string) : "";
  console.log(`\n=== 4. RESOLVE + social velocity for composite uuid="${uuid}" ===`);
  if (uuid) {
    const details = await get(`/track/${uuid}/details`);
    console.log(
      `\n[details] HTTP ${details.status}:`,
      preview((details.json as { data?: unknown })?.data ?? details.json).slice(0, 700),
    );
    const links = await get(`/track/${uuid}/links`);
    console.log(
      `\n[links] HTTP ${links.status}:`,
      preview((links.json as { data?: unknown })?.data ?? links.json).slice(0, 900),
    );

    const from = isoDaysAgo(45);
    const to = isoDaysAgo(0);
    for (const m of [
      {
        label: "shazam",
        path: `/track/${uuid}/shazam/shazams-historical?date-from=${from}&date-to=${to}`,
      },
      {
        label: "soundcloud",
        path: `/track/${uuid}/soundcloud/plays-historical?date-from=${from}&date-to=${to}`,
      },
      {
        label: "youtube",
        path: `/track/${uuid}/youtube/views-historical?date-from=${from}&date-to=${to}`,
      },
      {
        label: "spotify-maturity (streams)",
        path: `/track/${uuid}/spotify/streams-historical?date-from=${from}&date-to=${to}`,
      },
      { label: "spotify-maturity (playlists)", path: `/track/${uuid}/spotify/playlists` },
      { label: "viberate stats-alltime", path: `/track/${uuid}/viberate/stats-alltime` },
    ]) {
      const res = await get(m.path);
      const d = (res.json as { data?: unknown })?.data ?? res.json;
      console.log(
        `\n[${m.label}] HTTP ${res.status} -> ${res.ok ? keysOf(Array.isArray(d) ? d[0] : d) : "FAIL"}`,
      );
      if (res.ok)
        console.log("  sample:", preview(Array.isArray(d) ? d.slice(-2) : d).slice(0, 400));
    }
  } else {
    console.log("no composite uuid to resolve.");
  }

  console.log("\n=== DONE ===");
}

main().catch((e) => {
  console.error("probe threw:", e);
  process.exit(1);
});
