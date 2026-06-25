import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, inArray, sql } from "drizzle-orm";
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
  CHARTMETRIC_TRENDING_COUNTRY: "US",
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

/**
 * Generic trending-only spotify fixture. Returns the 3 fixture candidates for
 * `trending`/`search` and `[]` for `similar`/`explore` — it carries no
 * taste-seeded "more like this" or new-direction behavior. LAB-41 made the
 * spotify adapter a real similar-capable source and LAB-40 a real
 * explore-capable one, so a fixture that returned the same 3 candidates for
 * `mode:"similar"`/`mode:"explore"` would silently inject them into the
 * taste-seeded / explore passes once a bucket is seeded. Mode-gating keeps the
 * trending-pool counts honest; tests that exercise spotify-similar or
 * spotify-explore inject their own mode-aware mock.
 */
function fixtureAdapter(): SourceAdapter {
  return {
    id: "spotify",
    isPaid: false,
    isAvailable: () => true,
    pullCandidates: (async (params: { mode: string }) =>
      params.mode === "similar" || params.mode === "explore"
        ? ([] as RawCandidate[])
        : fixtureCandidates()) as unknown as SourceAdapter["pullCandidates"],
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

  it("contributes nothing when the only similar-capable source yields no similar candidates", async () => {
    // Seed a bucket so selectBucketSeeds returns a seed and the similar pass
    // actually runs (LAB-41: spotify is now similar-capable, so the pass is NOT
    // skipped just because lastfm is absent — it runs for spotify too).
    const seedPull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [fixtureAdapter()],
      limitPerSource: 10,
    });
    await seedBucketsEager(seedPull.resolvedTrackIds);

    // The spotify fixtureAdapter returns [] for mode:"similar", so the
    // spotify-similar pass runs but pulls nothing. pulledCount stays at the 3
    // trending candidates and no lastfm entry appears (no lastfm adapter).
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
        // Record only the trending pull's limit; the LAB-40 explore pass also
        // calls this adapter (mode:"explore") and would otherwise pollute the
        // assertion with its own limit.
        if (params.mode === "trending") seenLimits.push(params.limit);
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

describe("daily-pipeline (LAB-41 Spotify second taste-seeded similar source)", () => {
  /**
   * A candidate only Last.fm returns. Distinct ISRC so we can prove a track row
   * came from the Last.fm-similar pass.
   */
  function lastfmOnlyCandidate(): RawCandidate {
    return {
      source: "lastfm",
      sourceTrackId: "lfm-only-1",
      isrc: "LFMONLY000001",
      spotifyId: null,
      title: "Lastfm Only Track",
      artist: "Lastfm Only Artist",
      album: null,
      releaseYear: 2010,
      durationMs: 200_000,
      genres: ["idm"],
      rawPayload: {},
    };
  }

  /**
   * A candidate only Spotify returns. Distinct ISRC so we can prove a track row
   * came from the Spotify-similar pass (acceptance a).
   */
  function spotifyOnlyCandidate(): RawCandidate {
    return {
      source: "spotify",
      sourceTrackId: "spo-only-1",
      isrc: "SPOONLY000001",
      spotifyId: "spo-only-1",
      title: "Spotify Only Track",
      artist: "Spotify Only Artist",
      album: "Spotify Only Album",
      releaseYear: 2012,
      durationMs: 210_000,
      genres: ["electronic"],
      rawPayload: {},
    };
  }

  /**
   * The SAME underlying recording returned by BOTH sources — identical ISRC so
   * `resolveCandidate` folds them into ONE track row regardless of which source
   * variant resolves first (acceptance b). Last.fm's variant has no spotifyId;
   * Spotify's carries one — both share the ISRC, the primary dedup key.
   */
  const SHARED_ISRC = "SHARED0000001";
  function lastfmSharedCandidate(): RawCandidate {
    return {
      source: "lastfm",
      sourceTrackId: "lfm-shared",
      isrc: SHARED_ISRC,
      spotifyId: null,
      title: "Shared Track",
      artist: "Shared Artist",
      album: null,
      releaseYear: 2011,
      durationMs: 205_000,
      genres: ["idm"],
      rawPayload: {},
    };
  }
  function spotifySharedCandidate(): RawCandidate {
    return {
      source: "spotify",
      sourceTrackId: "spo-shared",
      isrc: SHARED_ISRC,
      spotifyId: "spo-shared",
      title: "Shared Track",
      artist: "Shared Artist",
      album: "Shared Album",
      releaseYear: 2011,
      durationMs: 205_000,
      genres: ["electronic"],
      rawPayload: {},
    };
  }

  /** lastfm mock: trending → []; similar → [shared, lastfm-only]. */
  function lastfmSimilarAdapter(): { adapter: SourceAdapter; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn(async (params: { mode: string }) => {
      if (params.mode === "similar") return [lastfmSharedCandidate(), lastfmOnlyCandidate()];
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

  /** spotify mock: trending → []; similar → [shared, spotify-only]. */
  function spotifySimilarAdapter(): { adapter: SourceAdapter; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn(async (params: { mode: string }) => {
      if (params.mode === "similar") return [spotifySharedCandidate(), spotifyOnlyCandidate()];
      return [] as RawCandidate[];
    });
    const adapter: SourceAdapter = {
      id: "spotify",
      isPaid: false,
      isAvailable: () => true,
      pullCandidates: spy as unknown as SourceAdapter["pullCandidates"],
    };
    return { adapter, spy };
  }

  /** Seed exactly one bucket so the similar pass issues exactly one seed. */
  async function seedOneBucket(): Promise<void> {
    const seedPull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [
        {
          id: "spotify",
          isPaid: false,
          isAvailable: () => true,
          pullCandidates: (async (params: { mode: string }) =>
            params.mode === "similar"
              ? ([] as RawCandidate[])
              : [
                  {
                    source: "spotify",
                    sourceTrackId: "seed-1",
                    isrc: "SEED00000001",
                    spotifyId: "seed-1",
                    title: "Seed Track",
                    artist: "Seed Artist",
                    album: "Seed Album",
                    releaseYear: 2000,
                    durationMs: 200_000,
                    genres: ["idm"],
                    rawPayload: {},
                  },
                ]) as unknown as SourceAdapter["pullCandidates"],
        },
      ],
      limitPerSource: 10,
    });
    await seedBucketsEager(seedPull.resolvedTrackIds);
  }

  it("pulls + resolves Spotify-similar candidates, dedups shared tracks, and shares the per-artist cap across both sources", async () => {
    await seedOneBucket();
    const bucketsBefore = await db.select().from(schema.bucket);
    expect(bucketsBefore.length).toBeGreaterThan(0);

    const { adapter: lfmAdapter, spy: lfmSpy } = lastfmSimilarAdapter();
    const { adapter: spoAdapter, spy: spoSpy } = spotifySimilarAdapter();

    const pull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [lfmAdapter, spoAdapter],
      limitPerSource: 10,
      similarSeedBuckets: 5,
      similarArtistCap: 2,
      // Disable the familiar-artist skip so the cap is the only lever in play.
      familiarArtistKeepThreshold: 0,
    });

    // Both sources issued similar pulls (mode:"similar"), Last.fm BEFORE Spotify.
    const lfmSimilar = lfmSpy.mock.calls.filter((c) => c[0]?.mode === "similar");
    const spoSimilar = spoSpy.mock.calls.filter((c) => c[0]?.mode === "similar");
    expect(lfmSimilar.length).toBeGreaterThan(0);
    expect(spoSimilar.length).toBeGreaterThan(0);

    // (a) Spotify-similar's distinct candidate round-tripped into a track row.
    const [spoTrack] = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(eq(schema.track.isrc, "SPOONLY000001"));
    expect(spoTrack).toBeDefined();
    if (!spoTrack) return;
    expect(pull.resolvedTrackIds).toContain(spoTrack.id);

    // (b) The track BOTH sources returned (shared ISRC) resolves to ONE row.
    const sharedRows = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(eq(schema.track.isrc, SHARED_ISRC));
    expect(sharedRows).toHaveLength(1);
    const sharedId = sharedRows[0]?.id;
    expect(sharedId).toBeDefined();
    // It appears exactly once in resolvedTrackIds (Set idempotency).
    expect(pull.resolvedTrackIds.filter((id) => id === sharedId)).toHaveLength(1);

    // (c) The per-artist cap is GLOBAL across both sources. "Shared Artist"
    //     appears once in each source's similar results (2 candidates total)
    //     under cap=2 → both kept, none capped. Raise the pressure: with the
    //     two shared candidates sharing one artist, the cap permits both; the
    //     two distinct artists (Lastfm Only / Spotify Only) are well under cap.
    //     So nothing is capped here, but the SHARED running map is proven by
    //     the dedup above + the combined count below.
    expect(pull.similarArtistCappedCount).toBe(0);

    // similarPulledCount is the COMBINED total across both sources:
    //   lastfm: shared + lastfm-only = 2; spotify: shared + spotify-only = 2.
    expect(pull.similarPulledCount).toBe(4);
    // Invariant: pulledCount === sum(perSource.pulled). Trending added 0 here.
    expect(pull.pulledCount).toBe(4);
    const perSourceSum = pull.perSource.reduce((acc, p) => acc + p.pulled, 0);
    expect(pull.pulledCount).toBe(perSourceSum);
    // Each source folded its similar pull into its OWN per-source entry.
    const lfmEntry = pull.perSource.find((p) => p.source === "lastfm");
    const spoEntry = pull.perSource.find((p) => p.source === "spotify");
    expect(lfmEntry?.pulled).toBe(2);
    expect(spoEntry?.pulled).toBe(2);

    // Distinct + shared candidates → 3 unique resolved tracks (shared folds
    // to one): lastfm-only + spotify-only + the single shared row.
    const similarRows = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(inArray(schema.track.isrc, ["SHARED0000001", "LFMONLY000001", "SPOONLY000001"]));
    expect(similarRows).toHaveLength(3);
  });

  it("enforces the per-artist cap GLOBALLY across Last.fm and Spotify (lever 1)", async () => {
    await seedOneBucket();

    // Both sources return the SAME artist; combined they exceed cap=1. Last.fm
    // runs first and fills the single slot; Spotify's same-artist candidate is
    // then capped — proving the running map is shared across sources.
    const sameArtist = (source: "lastfm" | "spotify", n: string): RawCandidate => ({
      source,
      sourceTrackId: `${source}-${n}`,
      isrc: `${source.toUpperCase().slice(0, 3)}${n.padStart(9, "0")}`,
      spotifyId: source === "spotify" ? `${source}-${n}` : null,
      title: `Capped ${n}`,
      artist: "Capped Artist",
      album: null,
      releaseYear: 2015,
      durationMs: 200_000,
      genres: ["idm"],
      rawPayload: {},
    });

    const lfm: SourceAdapter = {
      id: "lastfm",
      isPaid: false,
      isAvailable: () => true,
      pullCandidates: (async (params: { mode: string }) =>
        params.mode === "similar"
          ? [sameArtist("lastfm", "1")]
          : ([] as RawCandidate[])) as unknown as SourceAdapter["pullCandidates"],
    };
    const spo: SourceAdapter = {
      id: "spotify",
      isPaid: false,
      isAvailable: () => true,
      pullCandidates: (async (params: { mode: string }) =>
        params.mode === "similar"
          ? [sameArtist("spotify", "2")]
          : ([] as RawCandidate[])) as unknown as SourceAdapter["pullCandidates"],
    };

    const pull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [lfm, spo],
      limitPerSource: 10,
      similarSeedBuckets: 5,
      similarArtistCap: 1,
      familiarArtistKeepThreshold: 0,
    });

    // Combined 2 candidates of the same artist, cap=1 → exactly 1 capped.
    expect(pull.similarPulledCount).toBe(2);
    expect(pull.similarArtistCappedCount).toBe(1);
    // Last.fm ran first → its candidate took the slot and resolved.
    const lfmKept = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(eq(schema.track.isrc, "LAS000000001"));
    expect(lfmKept).toHaveLength(1);
    // Spotify's same-artist candidate was capped → never resolved (no row).
    const spoCapped = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(eq(schema.track.isrc, "SPO000000002"));
    expect(spoCapped).toHaveLength(0);
  });

  it("spotify-similar is a strict no-op when no spotify adapter is present", async () => {
    await seedOneBucket();

    // Only a Last.fm similar source. Spotify absent → spotify-similar must not
    // run at all (acceptance d). Spy proves no spotify call is issued.
    const { adapter: lfmAdapter, spy: lfmSpy } = lastfmSimilarAdapter();
    const pull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [lfmAdapter],
      limitPerSource: 10,
      similarSeedBuckets: 5,
      familiarArtistKeepThreshold: 0,
    });

    // Last.fm-similar ran (shared + lastfm-only = 2); no spotify entry exists.
    expect(pull.similarPulledCount).toBe(2);
    expect(pull.perSource.some((p) => p.source === "spotify")).toBe(false);
    expect(lfmSpy.mock.calls.filter((c) => c[0]?.mode === "similar").length).toBeGreaterThan(0);

    // The spotify-only candidate was never pulled → no such track row.
    const spoTrack = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(eq(schema.track.isrc, "SPOONLY000001"));
    expect(spoTrack).toHaveLength(0);
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

describe("surfaceStep — LAB-92 breakout projection onto candidates", () => {
  const embedding = () => Array.from({ length: schema.EMBEDDING_DIM }, () => 0);

  async function insertTrack(title: string, artist: string): Promise<number> {
    const [row] = await db
      .insert(schema.track)
      .values({ title, artist, genres: ["rock"], embedding: embedding() })
      .returning({ id: schema.track.id });
    if (!row) throw new Error("track insert returned no rows");
    return row.id;
  }

  it("projects raw_payload.breakout.score onto each candidate (MAX across sources) and freezes it into the pool", async () => {
    // loadCandidates does NOT join track_source by default — LAB-92 adds a
    // correlated MAX subquery. A track scored by two engines takes the
    // strongest breakout reading; a Spotify/Last.fm track has none.
    const aId = await insertTrack("Solo Breakout", "BandA"); // one engine, score 0.9
    const bId = await insertTrack("Mainstream", "BandB"); // Spotify only, no breakout
    const cId = await insertTrack("Two Engines", "BandC"); // viberate 0.4 + chartmetric 0.7 → MAX 0.7

    await db.insert(schema.trackSource).values([
      {
        trackId: aId,
        source: "viberate",
        sourceTrackId: "a-vib",
        rawPayload: { breakout: { provider: "viberate", feed: "composite-chart", score: 0.9 } },
      },
      {
        trackId: bId,
        source: "spotify",
        sourceTrackId: "b-spo",
        rawPayload: { popularity: 88 }, // no breakout key
      },
      {
        trackId: cId,
        source: "viberate",
        sourceTrackId: "c-vib",
        rawPayload: { breakout: { provider: "viberate", feed: "youtube-trending", score: 0.4 } },
      },
      {
        trackId: cId,
        source: "chartmetric",
        sourceTrackId: "c-cm",
        rawPayload: { breakout: { provider: "chartmetric", feed: "soundcloud", score: 0.7 } },
      },
    ]);

    // Bootstrap broad config carries the default knob (0.15). Pure broad (no
    // buckets → refill surfaces nothing): the un-penalized mainstream track
    // clears the default 0.5 bar and wins, while the down-weighted breakout
    // tracks stay in the full pool (Constraint #2).
    const surface = await surfaceStep(db, [aId, bId, cId]);
    expect(surface.surfacedCount).toBeGreaterThan(0);

    const [event] = await db.select().from(schema.surfaceEvent);
    if (!event) throw new Error("expected a surface event");
    const byId = new Map(event.candidatePool.map((p) => [p.trackId, p]));
    expect(byId.get(aId)?.breakout).toBe(0.9);
    expect(byId.get(cId)?.breakout).toBe(0.7); // MAX(0.4, 0.7) across the two engines
    expect(byId.get(bId)?.breakout).toBeUndefined(); // no breakout reading
    expect(Object.hasOwn(byId.get(bId)!, "breakout")).toBe(false);

    // The down-weight applied: higher breakout → smaller penalty → higher score
    // among the penalized pair, both below the un-penalized mainstream track.
    const aScore = byId.get(aId)!.score;
    const bScore = byId.get(bId)!.score;
    const cScore = byId.get(cId)!.score;
    expect(aScore).toBeCloseTo(0.5 - 0.15 * (1 - 0.9), 6); // 0.485
    expect(cScore).toBeCloseTo(0.5 - 0.15 * (1 - 0.7), 6); // 0.455
    expect(bScore).toBe(0.5);
    expect(aScore).toBeGreaterThan(cScore);
    expect(bScore).toBeGreaterThan(aScore);
    expect(byId.get(aId)?.subScores?.breakoutPenalty).toBeCloseTo(0.15 * 0.1, 6);
    expect(byId.get(bId)?.subScores?.breakoutPenalty).toBe(0);
  });
});

describe("daily-pipeline (LAB-40 explore: new-direction pulls outside bucket genres)", () => {
  it("selects genres outside the user's buckets and surfaces an out-of-bucket track via broad", async () => {
    // 1. Seed a ROCK bucket — the user's only represented genre. Explore is
    //    disabled during seeding so the seed pool is exactly the rock track.
    const rockSeed: RawCandidate = {
      source: "spotify",
      sourceTrackId: "rock-1",
      isrc: "ROCK00000001",
      spotifyId: "rock-1",
      title: "Rock Seed",
      artist: "Rock Band",
      album: "Rock LP",
      releaseYear: 2001,
      durationMs: 200_000,
      genres: ["rock"],
      rawPayload: {},
    };
    const seedPull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [
        {
          id: "spotify",
          isPaid: false,
          isAvailable: () => true,
          pullCandidates: (async (p: { mode: string }) =>
            p.mode === "trending"
              ? [rockSeed]
              : ([] as RawCandidate[])) as unknown as SourceAdapter["pullCandidates"],
        },
      ],
      limitPerSource: 10,
      exploreLimitPerSource: 0,
    });
    await seedBucketsEager(seedPull.resolvedTrackIds);
    expect((await db.select().from(schema.bucket)).length).toBeGreaterThan(0);

    // 2. Explore run — adapter returns a JAZZ track (genre absent from every
    //    bucket) for mode:"explore", nothing for trending/similar. The genre
    //    batch the pipeline passes must EXCLUDE the represented "rock".
    const jazzCand: RawCandidate = {
      source: "lastfm",
      sourceTrackId: "jazz-1",
      isrc: "JAZZ00000001",
      spotifyId: null,
      title: "Blue In Green",
      artist: "Jazz Trio",
      album: null,
      releaseYear: 2024,
      durationMs: 210_000,
      genres: ["jazz"],
      rawPayload: {},
    };
    const exploreSpy = vi.fn(async (p: { mode: string; genres?: string[] }) =>
      p.mode === "explore" ? [jazzCand] : ([] as RawCandidate[]),
    );
    const exploreAdapter: SourceAdapter = {
      id: "lastfm",
      isPaid: false,
      isAvailable: () => true,
      pullCandidates: exploreSpy as unknown as SourceAdapter["pullCandidates"],
    };

    const pull = await pullAndEnrichTrending(db, fixtureEnv, {
      adapters: [exploreAdapter],
      exploreLimitPerSource: 5,
    });

    // The explore pass ran with a non-empty genre batch that excludes the
    // represented "rock" — i.e. it reached OUTSIDE the user's current taste.
    const exploreCalls = exploreSpy.mock.calls.filter((c) => c[0]?.mode === "explore");
    expect(exploreCalls.length).toBeGreaterThan(0);
    const passedGenres = (exploreCalls[0]![0] as { genres: string[] }).genres;
    expect(passedGenres.length).toBeGreaterThan(0);
    expect(passedGenres).not.toContain("rock");

    // The jazz candidate round-tripped into a track row and is accounted for.
    expect(pull.explorePulledCount).toBe(1);
    const [jazzTrack] = await db
      .select({ id: schema.track.id })
      .from(schema.track)
      .where(eq(schema.track.isrc, "JAZZ00000001"));
    expect(jazzTrack).toBeDefined();
    if (!jazzTrack) return;
    expect(pull.resolvedTrackIds).toContain(jazzTrack.id);

    // 3. Flag (builds + persists the embedding) then surface. The broad phase
    //    surfaces the jazz track even though its genre is absent from every
    //    bucket — Constraint #4: genres are scored, never hard-filtered.
    await bucketAndName(db, fixtureEnv, pull.resolvedTrackIds);
    const surface = await surfaceStep(db, pull.resolvedTrackIds);
    expect(surface.surfacedCount).toBeGreaterThan(0);
    expect(surface.broadCount).toBeGreaterThan(0);
    const events = await db
      .select()
      .from(schema.surfaceEvent)
      .where(eq(schema.surfaceEvent.trackId, jazzTrack.id));
    expect(events.length).toBeGreaterThan(0);
  });
});
