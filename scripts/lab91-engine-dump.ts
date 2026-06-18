/**
 * LAB-91 QA — dump what a breakout engine actually produces, end to end.
 *
 * Runs one engine's adapter (`pullCandidates` in trending mode) against the live
 * API and prints, per candidate: identity + resolution (spotify id / ISRC /
 * genres / year) and the breakout signal that rides on rawPayload — so we can
 * eyeball (a) whether candidates resolve and (b) whether the pool skews
 * obscure/low-Spotify rather than the mainstream tail.
 *
 * Throwaway QA helper (not part of the app). Costs a few metered calls.
 *   pnpm tsx --env-file-if-exists=.env scripts/lab91-engine-dump.ts chartmetric
 *   pnpm tsx --env-file-if-exists=.env scripts/lab91-engine-dump.ts viberate
 */

import { chartmetricAdapter } from "@/lib/ingestion/chartmetric";
import { viberateAdapter } from "@/lib/ingestion/viberate";
import { loadEnv } from "@/server/env";

const which = (process.argv[2] ?? "chartmetric").trim();
const adapter =
  which === "viberate" ? viberateAdapter : which === "chartmetric" ? chartmetricAdapter : null;

if (!adapter) {
  console.error(`unknown source "${which}" — use chartmetric | viberate`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!adapter!.isAvailable(env)) {
    console.error(`${which}: isAvailable() === false (missing key) — aborting.`);
    process.exit(1);
  }
  console.log(`=== ${which}: pullCandidates({mode:'trending', limit:10}) ===\n`);
  const candidates = await adapter!.pullCandidates({ mode: "trending", limit: 10 }, env);
  console.log(`returned ${candidates.length} candidate(s)\n`);

  candidates.forEach((c, i) => {
    const payload = c.rawPayload as { breakout?: unknown } | null;
    console.log(
      `#${i + 1}  ${c.artist} — ${c.title}` +
        `\n     spotifyId=${c.spotifyId ?? "—"}  isrc=${c.isrc ?? "—"}  year=${c.releaseYear ?? "—"}` +
        `\n     genres=[${(c.genres ?? []).join(", ")}]` +
        `\n     breakout=${JSON.stringify(payload?.breakout ?? null)}\n`,
    );
  });
}

main().catch((e) => {
  console.error("dump threw:", e);
  process.exit(1);
});
