import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { track } from "@/db/schema";

/**
 * LAB-36 — one-shot READ-ONLY export of the dev DB `track` table into the
 * checked-in eval fixture `tests/fixtures/lab36-cohort.json`. The fixture is
 * the deterministic substrate for the reassignment replay eval
 * (tests/evals/lab36-reassignment-replay.test.ts) and the dev-only grid sweep
 * (scripts/lab36-grid.ts) — CI never needs the dev DB. Run manually:
 *
 *   DATABASE_URL=postgres://… pnpm tsx scripts/export-lab36-cohort.ts
 *
 * SELECTs only; id order pins the insertion sequence the replay reproduces.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const db = getDb(url);

try {
  const rows = await db
    .select({
      id: track.id,
      title: track.title,
      artist: track.artist,
      genres: track.genres,
      audioFeatures: track.audioFeatures,
    })
    .from(track)
    .orderBy(asc(track.id));

  const outPath = path.resolve(import.meta.dirname, "../tests/fixtures/lab36-cohort.json");
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(rows, null, 2)}\n`);
  const nullAudio = rows.filter((r) => r.audioFeatures === null).length;
  console.log(`exported ${rows.length} tracks (${nullAudio} null-audio) → ${outPath}`);
} finally {
  await closeDb();
}
