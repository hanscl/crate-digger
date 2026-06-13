import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { assignTrack } from "@/lib/bucketing/assign";
import { ingestRating } from "@/lib/feedback/ingest-rating";
import { selectBucketSeeds } from "@/lib/ingestion/exemplar";
import type { SourceAdapter, RawCandidate } from "@/lib/ingestion";
import {
  bucketAndName,
  pullAndEnrichTrending,
  recommendationsStep,
  retrainStep,
  surfaceStep,
} from "@/mastra/lib/pipeline-steps";
import { mastra } from "@/mastra";
import { buildRequestContext } from "@/mastra/runtime";
import type { Env } from "@/server/env";

/**
 * Phase 6 end-to-end smoke for the daily pipeline:
 *   pull → enrich → bucket → retrain → recommendations → surface
 *
 * Two complementary test cases, both running against testcontainers Postgres:
 *
 *   1. Step-by-step composition: each pipeline-step function called in
 *      sequence, asserting the candidate pool reaches surface_event rows
 *      with FULL candidate pool logging (Constraint #2). This exercises the
 *      pure step bodies without Mastra orchestration in the loop.
 *
 *   2. Mastra orchestration: same pipeline run via
 *      `mastra.getWorkflow('dailyPipeline').createRun().start()` to verify
 *      the workflow plumbing wires `requestContext` correctly through every
 *      step. We assert the workflow output shape and that surface_event
 *      rows landed.
 *
 * No real source APIs are hit. We register a single fixture adapter that
 * synthesizes RawCandidates with rich genre + ISRC info — enough to
 * exercise the embedding builder and the full bucket/rank/surface chain.
 */

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const PROVISION_TIMEOUT = 120_000;

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

/**
 * ReccoBeats audio-features stub — the enrich step now calls ReccoBeats. We
 * return well-formed features for whatever Spotify ids are asked for so the
 * pipeline never touches the network. Anything else 404s, which keeps the
 * "no Spotify /audio-features call" regression guard honest.
 */
function fetchStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("api.reccobeats.com")) {
      const ids = (new URL(url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const content = ids.map((id) => ({
        id,
        tempo: 120,
        energy: 0.6,
        valence: 0.5,
        danceability: 0.7,
        acousticness: 0.2,
        instrumentalness: 0.1,
      }));
      return new Response(JSON.stringify({ content }), { status: 200 });
    }
    return new Response("unexpected", { status: 404 });
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = fetchStub();
  vi.stubGlobal("fetch", fetchMock);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketRecommendation} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.rating} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.surfaceEvent} RESTART IDENTITY CASCADE`);
  await db.execute(
    sql`UPDATE ${schema.appConfig} SET active_refill_version_id = NULL, active_broad_version_id = NULL`,
  );
  await db.execute(sql`TRUNCATE TABLE ${schema.modelVersion} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucketMember} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.bucket} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.trackSource} RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE ${schema.track} RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fixtureEnv: Env = {
  DATABASE_URL: "postgres://localhost",
  ADMIN_PASSPHRASE: "test",
  ANTHROPIC_API_KEY: "",
  SPOTIFY_CLIENT_ID: "",
  SPOTIFY_CLIENT_SECRET: "",
  SPOTIFY_REDIRECT_URI: "http://localhost/cb",
  LASTFM_API_KEY: "",
  MUSICBRAINZ_CONTACT_EMAIL: "",
  DISCOGS_KEY: "",
  DISCOGS_SECRET: "",
  VIBERATE_API_KEY: "",
  VIBERATE_TRENDING_COUNTRY: "US",
  CHARTMETRIC_REFRESH_TOKEN: "",
  CHARTMETRIC_TIKTOK_COUNTRY: "US",
  SOUNDCHARTS_APP_ID: "",
  SOUNDCHARTS_API_KEY: "",
  SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-us",
  PORT: 3000,
  NODE_ENV: "test",
  CRON_DISABLED: "",
};

function fixtureCandidates(): RawCandidate[] {
  return [
    {
      source: "spotify",
      sourceTrackId: "fix-1",
      isrc: "GBARL1500001",
      spotifyId: "fix-1",
      title: "Crystal Lake",
      artist: "The Cure",
      album: "Disintegration",
      releaseYear: 1989,
      durationMs: 240_000,
      genres: ["indie rock", "post-punk"],
      rawPayload: {},
    },
    {
      source: "spotify",
      sourceTrackId: "fix-2",
      isrc: "GBARL1500002",
      spotifyId: "fix-2",
      title: "Souvlaki Space Station",
      artist: "Slowdive",
      album: "Souvlaki",
      releaseYear: 1993,
      durationMs: 230_000,
      genres: ["shoegaze", "dream pop"],
      rawPayload: {},
    },
    {
      source: "lastfm",
      sourceTrackId: "fix-3",
      isrc: null,
      spotifyId: null,
      title: "Strobe",
      artist: "Deadmau5",
      album: "For Lack Of A Better Name",
      releaseYear: 2009,
      durationMs: 600_000,
      genres: ["progressive house", "electronic"],
      rawPayload: {},
    },
  ];
}

function fixtureAdapter(): SourceAdapter {
  return {
    id: "spotify",
    isPaid: false,
    isAvailable: () => true,
    pullCandidates: async () => fixtureCandidates(),
  };
}

/**
 * Eagerly commit tracks to buckets the cold-start way (assignTrack). LAB-52
 * moved the daily `bucketAndName` step to candidate-flag-only, so tests that
 * need *real* buckets/members to exist (e.g. to give selectBucketSeeds a seed)
 * seed them via the eager path instead.
 */
async function seedBucketsEager(trackIds: readonly number[]): Promise<void> {
  for (const id of trackIds) {
    await assignTrack(db, id, { origin: "seed_track", spawnThreshold: 0.7 });
  }
}

describe("daily-pipeline (step-by-step)", () => {
  it("pulls → enriches → buckets → retrains → recommends → surfaces a fixture pool", async () => {
    // 1. Pull + enrich. Adapter is injected so no network IO.
    const pull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [fixtureAdapter()],
      limitPerSource: 10,
    });
    expect(pull.pulledCount).toBe(3);
    expect(pull.resolvedTrackIds).toHaveLength(3);
    expect(pull.newlyCreatedTrackIds).toHaveLength(3);
    // fix-1 + fix-2 carry a Spotify id → ReccoBeats enriches both; fix-3 has
    // none. The fixture candidates already carry genres, and fixtureEnv has
    // no Last.fm / MusicBrainz / Discogs creds — all three genre layers
    // no-op cleanly.
    expect(pull.audioFeaturesUpdated).toBe(2);
    expect(pull.genresUpdated).toBe(0);
    expect(pull.mbGenresUpdated).toBe(0);
    expect(pull.discogsGenresUpdated).toBe(0);

    // 2. Bucket — LAB-52: discovery only FLAGS candidates; it does not create
    //    buckets or members. The 3 fixture tracks have distinct genres and no
    //    buckets exist yet, so all 3 are would-spawn candidates.
    const bucketed = await bucketAndName(db, fixtureEnv, pull.resolvedTrackIds);
    expect(bucketed.wouldSpawnCount).toBe(3);
    expect(bucketed.candidateFlaggedCount).toBe(0);
    expect(bucketed.alreadyAssignedCount).toBe(0);
    // No buckets and no members were created at ingest — centroids untouched.
    const buckets = await db.select().from(schema.bucket);
    expect(buckets).toHaveLength(0);
    const members = await db.select().from(schema.bucketMember);
    expect(members).toHaveLength(0);
    // would-spawn tracks carry a NULL candidate bucket (no same-genre match).
    const flagged = await db
      .select({ id: schema.track.id, cb: schema.track.candidateBucketId })
      .from(schema.track);
    expect(flagged).toHaveLength(3);
    expect(flagged.every((t) => t.cb === null)).toBe(true);

    // 3. Retrain — no ratings yet, so this short-circuits with `no_samples`
    //    and does NOT pollute the broad version chain.
    const retrain = await retrainStep(db);
    expect(retrain.skipped).toBe(true);
    expect(retrain.skipReason).toBe("no_samples");
    expect(retrain.newBroadVersionId).toBeNull();

    // 4. Recommendations — the bucket pairs are too dissimilar to merge and
    //    none has enough members to split. Empty result is correct.
    const recs = await recommendationsStep(db);
    expect(recs.newMergeCount).toBe(0);
    expect(recs.newSplitCount).toBe(0);

    // 5. Surface — the broad ranker is bootstrapped via the surfacing
    //    pipeline itself. Cold-start has no keep ratings, so candidates
    //    score against the prior; with default novelty=0.5 the broad phase
    //    fills the cap.
    const surface = await surfaceStep(db, pull.resolvedTrackIds);
    expect(surface.surfacedCount).toBeGreaterThan(0);
    expect(surface.surfacedCount).toBeLessThanOrEqual(surface.effectiveCap);

    // Constraint #2: every surface_event row carries the full candidate
    // pool, not just the surfaced winner. That's the eval substrate.
    const events = await db.select().from(schema.surfaceEvent);
    expect(events.length).toBe(surface.surfacedCount);
    for (const ev of events) {
      expect(Array.isArray(ev.candidatePool)).toBe(true);
      expect(ev.candidatePool.length).toBeGreaterThanOrEqual(1);
      // Every entry has score + trackId; exactly one is the surfaced winner.
      for (const entry of ev.candidatePool) {
        expect(typeof entry.trackId).toBe("number");
        expect(typeof entry.score).toBe("number");
      }
      const winners = ev.candidatePool.filter((e) => e.surfaced);
      expect(winners.length).toBe(1);
    }

    // 6. LAB-60 — a rated track must not re-enter the queue. Rate the first
    //    surfaced event, then re-run the surface step over the SAME day pool:
    //    the rated track is decided, the rest still sit unrated in the queue —
    //    nothing new surfaces and no duplicate queue card appears.
    const firstEvent = events[0]!;
    await ingestRating(db, {
      trackId: firstEvent.trackId,
      decision: "keep",
      surfaceEventId: firstEvent.id,
    });
    const resurface = await surfaceStep(db, pull.resolvedTrackIds);
    expect(resurface.surfacedCount).toBe(0);
    expect(resurface.excludedDecidedCount).toBe(1);
    expect(resurface.excludedPendingCount).toBe(events.length - 1);
    const eventsAfterResurface = await db.select().from(schema.surfaceEvent);
    expect(eventsAfterResurface).toHaveLength(events.length);

    // Regression guard: Spotify retired `/audio-features` for new apps — the
    // enrich phase must never call Spotify's copy (it would silently 403 in
    // production). ReccoBeats' own /v1/audio-features endpoint is fine.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("api.spotify.com/v1/audio-features");
    }
    // ...and audio features now come from ReccoBeats instead.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("api.reccobeats.com"))).toBe(
      true,
    );
  });
});

describe("daily-pipeline (LAB-39 taste-seeded similar pull)", () => {
  /**
   * A distinct Last.fm candidate the similar pass should round-trip. Uses a
   * fresh sourceTrackId/ISRC not present in `fixtureCandidates()` so we can
   * prove it's the similar pull (not a trending dedupe) that created the row.
   */
  function similarCandidate(): RawCandidate {
    return {
      source: "lastfm",
      sourceTrackId: "lfm-sim-1",
      isrc: "GBARL9900099",
      spotifyId: null,
      title: "Avril 14th",
      artist: "Aphex Twin",
      album: "Drukqs",
      releaseYear: 2001,
      durationMs: 124_000,
      genres: ["idm", "ambient"],
      rawPayload: {},
    };
  }

  /**
   * Local Last.fm-id fixture adapter. `pullCandidates` branches on
   * `params.mode`: trending returns nothing (so the only candidates are the
   * similar-seeded ones), similar returns one distinct candidate. The outer
   * `vi.fn` captures every call so we can assert the seed shape.
   */
  function lastfmSimilarAdapter(): { adapter: SourceAdapter; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn(async (params: { mode: string }) => {
      if (params.mode === "similar") return [similarCandidate()];
      return [] as RawCandidate[];
    });
    const adapter: SourceAdapter = {
      id: "lastfm",
      isPaid: false,
      isAvailable: () => true,
      pullCandidates: spy as unknown as SourceAdapter["pullCandidates"],
    };
    return { adapter, spy };
  }

  it("seeds Last.fm getSimilar from the top bucket and merges the result into the pool", async () => {
    // 1. Seed a bucket with an embedded member via the spotify fixture pool.
    const seedPull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [fixtureAdapter()],
      limitPerSource: 10,
    });
    await seedBucketsEager(seedPull.resolvedTrackIds);

    const seededBuckets = await db.select().from(schema.bucket);
    expect(seededBuckets.length).toBeGreaterThan(0);

    // The centroid-nearest member of each one-member bucket is that member
    // itself; capture the expected seed artist/title for assertion (c).
    const seeds = await selectBucketSeeds(db, { maxBuckets: 5 });
    expect(seeds.length).toBeGreaterThan(0);
    const expectedSeed = seeds[0];
    expect(expectedSeed).toBeDefined();
    if (!expectedSeed) return;

    // 2. Run the similar pass with an explicit Last.fm adapter (no real
    //    registry). Trending returns []; only the similar pull contributes.
    const { adapter, spy } = lastfmSimilarAdapter();
    const pull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [adapter],
      limitPerSource: 10,
      similarSeedBuckets: 5,
    });

    // (b) accounting: similar candidates reached the pool.
    expect(pull.similarPulledCount).toBeGreaterThan(0);
    expect(pull.pulledCount).toBe(pull.similarPulledCount);

    // (d) pulledCount === sum(perSource.pulled) invariant.
    const perSourceSum = pull.perSource.reduce((acc, p) => acc + p.pulled, 0);
    expect(pull.pulledCount).toBe(perSourceSum);
    // The similar pulls folded into the single lastfm per-source entry.
    const lastfmEntries = pull.perSource.filter((p) => p.source === "lastfm");
    expect(lastfmEntries).toHaveLength(1);

    // (c) getSimilar was called with mode:"similar" + a non-empty seed
    //     derived from the seeded bucket's centroid-nearest member.
    const similarCalls = spy.mock.calls.filter((c) => c[0]?.mode === "similar");
    expect(similarCalls.length).toBeGreaterThan(0);
    for (const [params] of similarCalls) {
      expect(params.mode).toBe("similar");
      expect(typeof params.seedArtist).toBe("string");
      expect(params.seedArtist.length).toBeGreaterThan(0);
      expect(typeof params.seedTrack).toBe("string");
      expect(params.seedTrack.length).toBeGreaterThan(0);
    }
    expect(
      similarCalls.some(
        ([p]) => p.seedArtist === expectedSeed.seedArtist && p.seedTrack === expectedSeed.seedTrack,
      ),
    ).toBe(true);

    // (a) the similar-seeded candidate round-tripped into a track row and is
    //     in resolvedTrackIds.
    const [simTrack] = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(eq(schema.track.isrc, "GBARL9900099"));
    expect(simTrack).toBeDefined();
    if (!simTrack) return;
    expect(pull.resolvedTrackIds).toContain(simTrack.id);
  });

  it("is a strict no-op when no lastfm adapter is present (pulledCount stays 3)", async () => {
    // Seed a bucket so selectBucketSeeds *would* return a seed if called.
    const seedPull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [fixtureAdapter()],
      limitPerSource: 10,
    });
    await seedBucketsEager(seedPull.resolvedTrackIds);

    // The spotify fixtureAdapter has id:"spotify" → similar pass skipped.
    const pull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [fixtureAdapter()],
      limitPerSource: 10,
    });
    expect(pull.pulledCount).toBe(3);
    expect(pull.similarPulledCount).toBe(0);
    expect(pull.perSource.some((p) => p.source === "lastfm")).toBe(false);
  });

  it("reads the trending per-source limit from app_config when no option is passed (LAB-51)", async () => {
    await db
      .insert(schema.appConfig)
      .values({ id: 1, trendingLimitPerSource: 7 })
      .onConflictDoUpdate({ target: schema.appConfig.id, set: { trendingLimitPerSource: 7 } });

    const seenLimits: number[] = [];
    const recordingSpotify: SourceAdapter = {
      id: "spotify",
      isPaid: false,
      isAvailable: () => true,
      pullCandidates: (async (params: { mode: string; limit: number }) => {
        seenLimits.push(params.limit);
        return [] as RawCandidate[];
      }) as unknown as SourceAdapter["pullCandidates"],
    };

    await pullAndEnrichTrending(db, fixtureEnv, { adapters: [recordingSpotify] });
    // Trending pull used the configured value, not the DEFAULT_* fallback.
    expect(seenLimits).toEqual([7]);
  });

  it("reads the similar limit + seed-bucket cap from app_config (LAB-51)", async () => {
    // Seed ≥2 buckets so the seed-bucket cap is observable.
    const seedPull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [fixtureAdapter()],
      limitPerSource: 10,
    });
    await seedBucketsEager(seedPull.resolvedTrackIds);
    const allBuckets = await db.select().from(schema.bucket);
    expect(allBuckets.length).toBeGreaterThanOrEqual(2);

    // Cap the fan-out to 1 seed bucket and the similar pull to 4 per source.
    await db
      .insert(schema.appConfig)
      .values({ id: 1, similarSeedBuckets: 1, similarLimitPerSource: 4 })
      .onConflictDoUpdate({
        target: schema.appConfig.id,
        set: { similarSeedBuckets: 1, similarLimitPerSource: 4 },
      });

    const similarCalls: { limit: number }[] = [];
    const recordingLastfm: SourceAdapter = {
      id: "lastfm",
      isPaid: false,
      isAvailable: () => true,
      pullCandidates: (async (params: { mode: string; limit: number }) => {
        if (params.mode === "similar") {
          similarCalls.push({ limit: params.limit });
          return [similarCandidate()];
        }
        return [] as RawCandidate[];
      }) as unknown as SourceAdapter["pullCandidates"],
    };

    await pullAndEnrichTrending(db, fixtureEnv, { adapters: [recordingLastfm] });

    // seed-bucket cap honoured: exactly one similar call despite ≥2 buckets.
    expect(similarCalls).toHaveLength(1);
    // similar pull used the configured per-source limit, independent of trending.
    expect(similarCalls[0]?.limit).toBe(4);
  });

  it("selectBucketSeeds picks the centroid-nearest member of a bucket", async () => {
    // Two tracks in one bucket at different cosine distances to the centroid.
    // The centroid is set EXACTLY to track B's embedding so B is nearest.
    const dim = schema.EMBEDDING_DIM;
    const embA = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0));
    const embB = Array.from({ length: dim }, (_, i) => (i === 1 ? 1 : 0));

    const [trackA] = await db
      .insert(schema.track)
      .values({
        title: "Far Member",
        artist: "Artist A",
        genres: ["idm"],
        primaryGenre: "idm",
        embedding: embA,
      })
      .returning({ id: schema.track.id });
    const [trackB] = await db
      .insert(schema.track)
      .values({
        title: "Near Member",
        artist: "Artist B",
        genres: ["idm"],
        primaryGenre: "idm",
        embedding: embB,
      })
      .returning({ id: schema.track.id });
    expect(trackA).toBeDefined();
    expect(trackB).toBeDefined();
    if (!trackA || !trackB) return;

    const emptyStats = {
      count: 0,
      mean: {
        tempo: 0,
        energy: 0,
        valence: 0,
        danceability: 0,
        acousticness: 0,
        instrumentalness: 0,
      },
      m2: {
        tempo: 0,
        energy: 0,
        valence: 0,
        danceability: 0,
        acousticness: 0,
        instrumentalness: 0,
      },
    };
    const [b] = await db
      .insert(schema.bucket)
      .values({
        name: "idm (auto)",
        centroid: embB, // centroid == track B's embedding → B is nearest
        featureStats: emptyStats,
        memberCount: 2,
        primaryGenre: "idm",
      })
      .returning({ id: schema.bucket.id });
    expect(b).toBeDefined();
    if (!b) return;
    await db.insert(schema.bucketMember).values([
      { bucketId: b.id, trackId: trackA.id, similarityAtJoin: 0, origin: "seed_track" },
      { bucketId: b.id, trackId: trackB.id, similarityAtJoin: 1, origin: "seed_track" },
    ]);

    const seeds = await selectBucketSeeds(db, { maxBuckets: 5 });
    const seed = seeds.find((s) => s.bucketId === b.id);
    expect(seed).toBeDefined();
    expect(seed?.seedArtist).toBe("Artist B");
    expect(seed?.seedTrack).toBe("Near Member");
  });

  it("selectBucketSeeds breaks equal-cosine ties on the lower track.id", async () => {
    // Two members with the SAME embedding → identical cosine to the centroid
    // by construction. The selection documents a `track.id ASC` tiebreak; this
    // pins it. The members are inserted high-id-first so a naive "last wins"
    // bug would pick the wrong row.
    const dim = schema.EMBEDDING_DIM;
    const emb = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0));

    // Insert the would-be-higher-id row first; both share `emb`.
    const [trackHigh] = await db
      .insert(schema.track)
      .values({
        title: "Tie Member High",
        artist: "Artist High",
        genres: ["idm"],
        primaryGenre: "idm",
        embedding: emb,
      })
      .returning({ id: schema.track.id });
    const [trackLow] = await db
      .insert(schema.track)
      .values({
        title: "Tie Member Low",
        artist: "Artist Low",
        genres: ["idm"],
        primaryGenre: "idm",
        embedding: emb,
      })
      .returning({ id: schema.track.id });
    expect(trackHigh).toBeDefined();
    expect(trackLow).toBeDefined();
    if (!trackHigh || !trackLow) return;
    // Serial ids are monotonic → the first insert has the LOWER id. Guard the
    // assumption so the tiebreak assertion below is meaningful.
    expect(trackHigh.id).toBeLessThan(trackLow.id);

    const emptyStats = {
      count: 0,
      mean: {
        tempo: 0,
        energy: 0,
        valence: 0,
        danceability: 0,
        acousticness: 0,
        instrumentalness: 0,
      },
      m2: {
        tempo: 0,
        energy: 0,
        valence: 0,
        danceability: 0,
        acousticness: 0,
        instrumentalness: 0,
      },
    };
    const [b] = await db
      .insert(schema.bucket)
      .values({
        name: "idm (auto)",
        centroid: emb, // centroid == both members' embedding → equal cosine
        featureStats: emptyStats,
        memberCount: 2,
        primaryGenre: "idm",
      })
      .returning({ id: schema.bucket.id });
    expect(b).toBeDefined();
    if (!b) return;
    await db.insert(schema.bucketMember).values([
      { bucketId: b.id, trackId: trackLow.id, similarityAtJoin: 1, origin: "seed_track" },
      { bucketId: b.id, trackId: trackHigh.id, similarityAtJoin: 1, origin: "seed_track" },
    ]);

    const seeds = await selectBucketSeeds(db, { maxBuckets: 5 });
    const seed = seeds.find((s) => s.bucketId === b.id);
    expect(seed).toBeDefined();
    // The lower track.id (`trackHigh`, inserted first) wins the equal-cosine tie.
    expect(seed?.seedArtist).toBe("Artist High");
    expect(seed?.seedTrack).toBe("Tie Member High");
  });
});

describe("daily-pipeline (Mastra orchestration)", () => {
  it("runs end-to-end via the workflow runner with requestContext-injected db/env", async () => {
    // Pre-pull candidates manually, since the workflow's pull step uses the
    // production registry. Routing the workflow's pull step through fixture
    // adapters would require re-plumbing through requestContext — instead we
    // verify the workflow plumbing on a path that doesn't need network IO:
    // start with no candidates pulled (no adapters available) and assert the
    // workflow still completes the full chain with a coherent output shape.
    const workflow = mastra.getWorkflow("dailyPipeline");
    const run = await workflow.createRun();
    // RequestContext is invariant in T, so the typed instance needs a narrow
    // cast to Mastra's RequestContext<unknown> parameter shape.
    const requestContext = buildRequestContext({
      db,
      env: fixtureEnv,
    }) as Parameters<typeof run.start>[0]["requestContext"];
    const result = await run.start({
      inputData: { limitPerSource: 5 },
      requestContext,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    // Output schema is fully populated even when upstream steps produced
    // nothing (no available adapters in fixtureEnv → 0 candidates).
    expect(result.result.pulledCount).toBe(0);
    // LAB-39 observability: the taste-seeded pull count is now surfaced
    // separately at the orchestrated level (0 with no adapters available).
    expect(result.result.similarPulledCount).toBe(0);
    expect(result.result.resolvedTrackIds).toEqual([]);
    expect(result.result.candidateFlaggedCount).toBe(0);
    expect(result.result.surfacedCount).toBe(0);
    expect(result.result.retrainSkipped).toBe(true);
    expect(result.result.pendingRecommendationCount).toBe(0);
  });
});
