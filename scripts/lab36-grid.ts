import { readFileSync } from "node:fs";
import path from "node:path";
import type { AudioFeatures } from "@/db/schema";
import { genreScopeCompatible, sameGenreScope } from "@/lib/bucketing/genre-scope";
import { updateCentroid } from "@/lib/bucketing/centroid";
import { buildEmbedding, derivePrimaryGenre, weightedCosine } from "@/lib/embedding";

/**
 * LAB-36 — dev-only grid sweep over the checked-in cohort fixture
 * (tests/fixtures/lab36-cohort.json): audioWeight w ∈ {1.5, 2, 2.5, 3, 4} ×
 * genre gate ∈ {exact, slot-overlap, none}, simulating sequential
 * spawn-or-join assignment (id order, spawnThreshold 0.7) entirely
 * in-process. Per cell: the three named cases pass/fail, bucket count,
 * max-bucket share, and p50/p90 of member→centroid weighted cosine (proxy
 * for the refill keepSim scale shift). Not part of CI — run with:
 *
 *   pnpm tsx scripts/lab36-grid.ts
 */

type CohortRow = {
  id: number;
  title: string;
  artist: string;
  genres: string[];
  audioFeatures: AudioFeatures | null;
};

type SimBucket = {
  id: number;
  primaryGenre: string | null;
  centroid: number[];
  memberIds: number[];
};

type Gate = "exact" | "slot-overlap" | "none";

const SPAWN_THRESHOLD = 0.7;
// 1 × exact is the pre-LAB-36 status quo — the baseline row for the
// keepSim-scale-inflation comparison; the ticket's sweep is 1.5..4.
const WEIGHTS = [1, 1.5, 2, 2.5, 3, 4];
const GATES: Gate[] = ["exact", "slot-overlap", "none"];

const fixturePath = path.resolve(import.meta.dirname, "../tests/fixtures/lab36-cohort.json");
const cohort: CohortRow[] = JSON.parse(readFileSync(fixturePath, "utf8"));

const byTitleArtist = (artist: string, title: string): CohortRow => {
  const row = cohort.find((r) => r.artist === artist && r.title === title);
  if (!row) throw new Error(`fixture missing ${artist} — ${title}`);
  return row;
};

const MTW = byTitleArtist("Extreme", "More Than Words");
const TING = byTitleArtist("Extreme", "There Is No God");
const SMG = byTitleArtist("Spider Murphy Gang", "Skandal im Sperrbezirk - Remastered 2007");
const EXTRABREIT = byTitleArtist("Extrabreit", "Hurra, hurra, die Schule brennt");
const SHINS = byTitleArtist("The Shins, James Mercer", "Simple Song");
const BOH = byTitleArtist("Band of Horses", "Laredo");

function simulate(audioWeight: number, gate: Gate): Map<number, SimBucket> {
  const buckets: SimBucket[] = [];
  const assignment = new Map<number, SimBucket>();
  let nextId = 1;
  for (const row of [...cohort].sort((a, b) => a.id - b.id)) {
    const embedding = buildEmbedding({ audioFeatures: row.audioFeatures, genres: row.genres });
    const primaryGenre = derivePrimaryGenre(row.genres);
    // Null-audio damping: neutral 0.5 fills must not become promiscuous
    // joiners when audio dims are up-weighted (mirrors assign.ts).
    const w = row.audioFeatures === null ? 1 : audioWeight;
    let best: { bucket: SimBucket; sim: number } | null = null;
    for (const b of buckets) {
      const compatible =
        gate === "none"
          ? true
          : gate === "exact"
            ? sameGenreScope(primaryGenre, b.primaryGenre)
            : genreScopeCompatible("slot-overlap", { primaryGenre, embedding }, b);
      if (!compatible) continue;
      const sim = weightedCosine(embedding, b.centroid, w);
      if (!best || sim > best.sim) best = { bucket: b, sim };
    }
    if (best && best.sim >= SPAWN_THRESHOLD) {
      best.bucket.centroid = updateCentroid(
        best.bucket.centroid,
        best.bucket.memberIds.length,
        embedding,
      );
      best.bucket.memberIds.push(row.id);
      assignment.set(row.id, best.bucket);
    } else {
      const b: SimBucket = { id: nextId++, primaryGenre, centroid: embedding, memberIds: [row.id] };
      buckets.push(b);
      assignment.set(row.id, b);
    }
  }
  return assignment;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? Number.NaN;
}

function meanEnergy(memberIds: number[]): number | null {
  const rows = memberIds
    .map((id) => cohort.find((r) => r.id === id))
    .filter((r): r is CohortRow => r !== undefined && r.audioFeatures !== null);
  if (rows.length === 0) return null;
  return rows.reduce((s, r) => s + (r.audioFeatures?.energy ?? 0), 0) / rows.length;
}

console.log(
  "| w | gate | A (MTW≠TING + ballad) | B (SMG=Extrabreit) | C (Shins=BoH) | buckets | max share | keepSim p50 | p90 |",
);
console.log("|---|------|------|------|------|---------|-----------|------|-----|");
for (const w of WEIGHTS) {
  for (const gate of GATES) {
    const assignment = simulate(w, gate);
    const buckets = new Set(assignment.values());
    const total = assignment.size;
    const maxShare = Math.max(...[...buckets].map((b) => b.memberIds.length)) / total;

    const mtwBucket = assignment.get(MTW.id)!;
    const caseAseparated = mtwBucket !== assignment.get(TING.id);
    const mtwEnergy = meanEnergy(mtwBucket.memberIds);
    const caseA = caseAseparated && mtwEnergy !== null && mtwEnergy < 0.5;
    const caseB = assignment.get(SMG.id) === assignment.get(EXTRABREIT.id);
    const caseC = assignment.get(SHINS.id) === assignment.get(BOH.id);

    // keepSim proxy: every member's weighted cosine to its final bucket
    // centroid (same damping rule as assignment).
    const sims: number[] = [];
    for (const b of buckets) {
      for (const id of b.memberIds) {
        const row = cohort.find((r) => r.id === id)!;
        const emb = buildEmbedding({ audioFeatures: row.audioFeatures, genres: row.genres });
        sims.push(weightedCosine(emb, b.centroid, row.audioFeatures === null ? 1 : w));
      }
    }
    sims.sort((a, b) => a - b);

    const fmt = (x: boolean) => (x ? "PASS" : "fail");
    console.log(
      `| ${w} | ${gate} | ${fmt(caseA)}${caseAseparated ? "" : " (merged)"}${mtwEnergy !== null && mtwEnergy >= 0.5 && caseAseparated ? " (energy)" : ""} | ${fmt(caseB)} | ${fmt(caseC)} | ${buckets.size} | ${(maxShare * 100).toFixed(1)}% | ${percentile(sims, 50).toFixed(3)} | ${percentile(sims, 90).toFixed(3)} |`,
    );
  }
}
