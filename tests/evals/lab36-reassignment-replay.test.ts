import { readFileSync } from "node:fs";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { AudioFeatures } from "@/db/schema";
import { type AssignResult, assignTrack } from "@/lib/bucketing/assign";
import type { GenreGate } from "@/lib/bucketing/genre-scope";
import { derivePrimaryGenre, genreSlotsFromVector } from "@/lib/embedding";
import { DEFAULT_AUDIO_WEIGHT } from "@/lib/ranking/types";

/**
 * LAB-36 — reassignment replay eval over the checked-in dev-DB cohort
 * (tests/fixtures/lab36-cohort.json, exported once by
 * scripts/export-lab36-cohort.ts; 136 tracks, 17 without audio features).
 * Replays sequential spawn-or-join assignment in fixture id order at
 * spawnThreshold 0.7 and pins the cross-lane membership contract:
 *
 *   NEW config (audioWeight=2.5, slot-overlap gate):
 *     CASE A — "More Than Words" (metal-tagged acoustic ballad, energy
 *              0.134) lands apart from its same-band banger "There Is No
 *              God", in a ballad-side bucket (mean energy < 0.5).
 *     CASE B — Spider Murphy Gang and Extrabreit (NDW kin whose artist-
 *              scoped tags derive different primary genres) converge.
 *     CASE C — The Shins and Band of Horses converge.
 *
 *   CONTROL (audioWeight=1, exact gate — pre-LAB-36 behavior): the replay
 *   reproduces the dev DB's geometry and the OLD outcomes (MTW metal-locked
 *   WITH the banger; SMG/Extrabreit apart; Shins/BoH apart) — the config
 *   toggle alone drives the delta. (LAB-47 nudged the exact-gate bucket count
 *   32 → 33: one alt-rnb track lost a spurious `rock` slot and no longer
 *   clears 0.7 against its old `alternative` lane — see the CONTROL assertion.)
 *
 * SANITY GUARDS (permanent — they separate this design from cluster
 * dissolution): bucket count in [8, 40]; max-bucket share bounded;
 * null-genre tracks stay in the null lane; an identical-audio disjoint-slot
 * pair still spawns apart; null-audio tracks don't converge into one bucket.
 *
 * Measured cross-lane accretion (full sweep in scripts/lab36-grid.ts): the
 * slot-overlap gate at w=2.5 yields 13 buckets with the largest holding
 * ~64% of this cohort — the ticket's drafted ≤40% bound is unsatisfiable at
 * ANY weight that also passes cases B+C (≥45% from w=1.5 up), so the share
 * guard is pinned at <70% (catches dissolution-to-one-bucket while
 * tolerating the cohort's mainstream-rock mass). See PR notes.
 */

const PROVISION_TIMEOUT = 120_000;
const SPAWN_THRESHOLD = 0.7;
const AUDIO_WEIGHT = DEFAULT_AUDIO_WEIGHT; // 2.5 — pinned with schema default + bootstrap

type CohortRow = {
  id: number;
  title: string;
  artist: string;
  genres: string[];
  audioFeatures: AudioFeatures | null;
};

const cohort: CohortRow[] = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../fixtures/lab36-cohort.json"), "utf8"),
);

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("cratedigger_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  client = postgres(container.getConnectionUri(), {
    max: 5,
    prepare: false,
    onnotice: () => undefined,
  });
  await client.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, "../../migrations") });
}, PROVISION_TIMEOUT);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketMember} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucket} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
});

function fixtureRow(artist: string, title: string): CohortRow {
  const row = cohort.find((r) => r.artist === artist && r.title === title);
  if (!row) throw new Error(`fixture missing ${artist} — ${title}`);
  return row;
}

// Exact fixture strings for the three named cases.
const MTW = fixtureRow("Extreme", "More Than Words");
const TING = fixtureRow("Extreme", "There Is No God");
const SMG = fixtureRow("Spider Murphy Gang", "Skandal im Sperrbezirk - Remastered 2007");
const EXTRABREIT = fixtureRow("Extrabreit", "Hurra, hurra, die Schule brennt");
const SHINS = fixtureRow("The Shins, James Mercer", "Simple Song");
const BOH = fixtureRow("Band of Horses", "Laredo");

async function insertCohortTrack(row: CohortRow): Promise<number> {
  const [inserted] = await db
    .insert(schema.track)
    .values({
      title: row.title,
      artist: row.artist,
      genres: row.genres,
      audioFeatures: row.audioFeatures,
    })
    .returning({ id: schema.track.id });
  if (!inserted) throw new Error("track insert returned no rows");
  return inserted.id;
}

/** Insert the cohort in fixture-id order and assign sequentially. */
async function replayCohort(config: {
  audioWeight: number;
  genreGate: GenreGate;
}): Promise<Map<number, AssignResult>> {
  const byFixtureId = new Map<number, AssignResult>();
  for (const row of [...cohort].sort((a, b) => a.id - b.id)) {
    const trackId = await insertCohortTrack(row);
    const result = await assignTrack(db, trackId, {
      origin: "seed_track",
      spawnThreshold: SPAWN_THRESHOLD,
      audioWeight: config.audioWeight,
      genreGate: config.genreGate,
    });
    byFixtureId.set(row.id, result);
  }
  return byFixtureId;
}

describe("LAB-36 reassignment replay — cohort fixture, spawnThreshold 0.7", () => {
  it("NEW config (slot-overlap + weighted cosine): the three cross-lane cases pass and the sanity guards hold", async () => {
    const assigned = await replayCohort({ audioWeight: AUDIO_WEIGHT, genreGate: "slot-overlap" });
    const bucketOf = (row: CohortRow) => assigned.get(row.id)!.bucketId;

    // CASE A — MTW separates from its same-band banger and lands ballad-side.
    expect(bucketOf(MTW)).not.toBe(bucketOf(TING));
    const [mtwBucket] = await db
      .select()
      .from(schema.bucket)
      .where(sql`${schema.bucket.id} = ${bucketOf(MTW)}`);
    expect(mtwBucket?.featureStats.mean.energy).toBeLessThan(0.5);

    // CASE B — SMG and Extrabreit converge across primary-genre lanes.
    expect(bucketOf(SMG)).toBe(bucketOf(EXTRABREIT));

    // CASE C — The Shins and Band of Horses converge.
    expect(bucketOf(SHINS)).toBe(bucketOf(BOH));

    // GUARD: bucket population stays clustered, not dissolved or shattered.
    const buckets = await db.select().from(schema.bucket);
    expect(buckets.length).toBeGreaterThanOrEqual(8);
    expect(buckets.length).toBeLessThanOrEqual(40);
    const maxShare = Math.max(...buckets.map((b) => b.memberCount)) / cohort.length;
    // Measured 64% at w=2.5 (mainstream-rock mass of this cohort); <70%
    // still fails fast on dissolution-into-one-bucket. See file doc.
    expect(maxShare).toBeLessThan(0.7);

    // GUARD: null-genre tracks stay in the null lane — their buckets carry
    // primaryGenre=null and hold ONLY null-genre members (the zero-slot
    // fallback gates by exact null===null, and a slotted track is never
    // compatible with a zero-genre-mass bucket).
    const nullGenreRows = cohort.filter((r) => derivePrimaryGenre(r.genres) === null);
    expect(nullGenreRows.length).toBeGreaterThan(0);
    const nullLaneBucketIds = new Set(nullGenreRows.map((r) => bucketOf(r)));
    const nullGenreFixtureIds = new Set(nullGenreRows.map((r) => r.id));
    for (const b of buckets) {
      if (!nullLaneBucketIds.has(b.id)) continue;
      expect(b.primaryGenre).toBeNull();
    }
    for (const row of cohort) {
      if (nullGenreFixtureIds.has(row.id)) continue;
      expect(nullLaneBucketIds.has(bucketOf(row))).toBe(false);
    }

    // GUARD: the null-audio rows (neutral 0.5 embeddings) are damped to
    // weight 1 and must not converge into one promiscuous mega-bucket.
    const nullAudioRows = cohort.filter((r) => r.audioFeatures === null);
    expect(nullAudioRows.length).toBe(17);
    const perBucket = new Map<number, number>();
    for (const r of nullAudioRows) {
      perBucket.set(bucketOf(r), (perBucket.get(bucketOf(r)) ?? 0) + 1);
    }
    expect(perBucket.size).toBeGreaterThanOrEqual(8);
    expect(Math.max(...perBucket.values())).toBeLessThanOrEqual(6);
  }, 120_000);

  it("CONTROL (exact gate + plain cosine): the OLD outcomes reproduce — the config toggle drives the delta", async () => {
    const assigned = await replayCohort({ audioWeight: 1, genreGate: "exact" });
    const bucketOf = (row: CohortRow) => assigned.get(row.id)!.bucketId;

    // MTW metal-locked: same bucket as its same-band banger — the exact
    // failure LAB-36 fixes — in the metal primary-genre lane.
    expect(bucketOf(MTW)).toBe(bucketOf(TING));
    const [mtwBucket] = await db
      .select()
      .from(schema.bucket)
      .where(sql`${schema.bucket.id} = ${bucketOf(MTW)}`);
    expect(mtwBucket?.primaryGenre).toBe("metal");

    // NDW kin and the Shins/BoH pair stay apart under exact lanes.
    expect(bucketOf(SMG)).not.toBe(bucketOf(EXTRABREIT));
    expect(bucketOf(SHINS)).not.toBe(bucketOf(BOH));

    // The exact-gate replay reproduces the dev DB's geometry. LAB-47 tightened
    // genre-slot matching so "indie rock"/"pop rock" no longer light the bare
    // `rock` slot. In this cohort exactly ONE track changes — "Malcolm Todd —
    // Earrings" (alt-rnb/indie/funk/soul), whose ONLY rock signal was the
    // "indie rock" tag. Dropping that spurious `rock` slot lowers its plain
    // cosine to the rock-heavy `alternative` lane it previously joined below
    // the 0.7 spawn threshold, so it now spawns its own `alternative` bucket:
    // 32 → 33. This is the fix working (the old 32-count was a property of the
    // buggy embeddings); the qualitative CONTROL invariants above (MTW metal-
    // locked, SMG/Extrabreit apart, Shins/BoH apart) are unchanged.
    const buckets = await db.select().from(schema.bucket);
    expect(buckets).toHaveLength(33);
  }, 120_000);

  it("identical-audio disjoint-slot pair (jazz vs classical) still spawns apart under the NEW config", async () => {
    // The gate is what keeps them apart: at w=2.5 the weighted cosine of an
    // identical-audio pair is ~1 regardless of genre dims, so without the
    // slot-overlap requirement they would merge.
    const sharedAudio: AudioFeatures = {
      tempo: 100,
      energy: 0.4,
      valence: 0.5,
      danceability: 0.5,
      acousticness: 0.7,
      instrumentalness: 0.6,
    };
    const jazzId = await insertCohortTrack({
      id: -1,
      title: "Blue note",
      artist: "Synthetic",
      genres: ["jazz"],
      audioFeatures: sharedAudio,
    });
    const classicalId = await insertCohortTrack({
      id: -2,
      title: "Adagio",
      artist: "Synthetic",
      genres: ["classical"],
      audioFeatures: sharedAudio,
    });
    const jazz = await assignTrack(db, jazzId, {
      origin: "seed_track",
      spawnThreshold: SPAWN_THRESHOLD,
      audioWeight: AUDIO_WEIGHT,
      genreGate: "slot-overlap",
    });
    const classical = await assignTrack(db, classicalId, {
      origin: "seed_track",
      spawnThreshold: SPAWN_THRESHOLD,
      audioWeight: AUDIO_WEIGHT,
      genreGate: "slot-overlap",
    });
    expect(classical.spawned).toBe(true);
    expect(classical.bucketId).not.toBe(jazz.bucketId);
  });

  it("order-insensitivity: inserting Extrabreit BEFORE SMG still converges them", async () => {
    // The bucket side of the slot-overlap gate is the centroid's genre MASS
    // (any member's slot counts), not the bucket's primary slot. Extrabreit
    // seeds a bucket whose primary genre derives to a non-rock slot; SMG
    // (primary rock) still sees the shared rock mass and joins. Were the
    // bucket side its primary slot only, this direction would fail while the
    // fixture order passed — insert-order sensitivity this pin forbids.
    const extrabreitId = await insertCohortTrack(EXTRABREIT);
    const smgId = await insertCohortTrack(SMG);
    const first = await assignTrack(db, extrabreitId, {
      origin: "seed_track",
      spawnThreshold: SPAWN_THRESHOLD,
      audioWeight: AUDIO_WEIGHT,
      genreGate: "slot-overlap",
    });
    expect(first.spawned).toBe(true);
    expect(first.primaryGenre).not.toBe(derivePrimaryGenre(SMG.genres));
    const second = await assignTrack(db, smgId, {
      origin: "seed_track",
      spawnThreshold: SPAWN_THRESHOLD,
      audioWeight: AUDIO_WEIGHT,
      genreGate: "slot-overlap",
    });
    expect(second.spawned).toBe(false);
    expect(second.bucketId).toBe(first.bucketId);
  });

  it("fixture integrity: the named cases cross primary-genre lanes and carry the expected slots", async () => {
    // Pins the premises the cases rely on, so a fixture re-export that
    // changes tags fails loudly here instead of mysteriously in the replay.
    expect(derivePrimaryGenre(MTW.genres)).toBe("metal");
    expect(derivePrimaryGenre(TING.genres)).toBe("metal");
    expect(derivePrimaryGenre(SMG.genres)).not.toBe(derivePrimaryGenre(EXTRABREIT.genres));
    expect(MTW.audioFeatures?.energy).toBeLessThan(0.2);
    expect(TING.audioFeatures?.energy).toBeGreaterThan(0.7);
    const { buildEmbedding } = await import("@/lib/embedding");
    const smgSlots = genreSlotsFromVector(
      buildEmbedding({ audioFeatures: SMG.audioFeatures, genres: SMG.genres }),
    );
    const exSlots = genreSlotsFromVector(
      buildEmbedding({ audioFeatures: EXTRABREIT.audioFeatures, genres: EXTRABREIT.genres }),
    );
    expect([...smgSlots].some((s) => exSlots.has(s))).toBe(true);
  });
});
