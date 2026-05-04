# Progress

Phase tracker. Update at the end of every phase. Newest at the top.

## Phase 1 — Skeleton + DB

- **Status:** review
- **Branch:** `phase-1-skeleton`
- **PR:** https://github.com/hanscl/crate-digger/pull/1
- **Scope landed:** repo scaffold, pnpm + Node 24 + TS strict, oxlint + oxfmt + lefthook,
  docker-compose with pgvector, Dockerfile, `.env.example`, Drizzle schema for all 10 tables
  (`track`, `track_source`, `bucket`, `bucket_member`, `model_version`, `surface_event`, `rating`,
  `search_run`, `bucket_recommendation`, `app_config`), Hono + tRPC hello + cookie auth,
  Vite + React + Tailwind + IBM Plex shell with sidebar + 6 placeholder screens, `docs/PLAN.md`,
  `docs/PROGRESS.md`, `CLAUDE.md`, GitHub Actions CI.
- **Notes for future phases:** none yet.

## Phase 2 — Ingestion + enrichment

- **Status:** review
- **Branch:** `phase-2-ingestion` (rebased onto `main` after #1 merged)
- **PR:** https://github.com/hanscl/crate-digger/pull/3 (supersedes #2)
- **Scope landed:** `SourceAdapter` interface + registry; Spotify adapter
  (Client Credentials, search/trending/similar, ISRC pass-through); Last.fm
  adapter (search/similar/chart top tracks); Viberate adapter stub; ISRC-first
  enrichment resolver with fuzzy fallback (`fast-fuzzy`) and conflicting-ISRC
  guard; Spotify audio-features fetcher with widen-only backfill; first drizzle
  migration generated (`migrations/0000_*`); testcontainers-pg integration
  harness; adapter contract test (16 cases) + enrichment idempotency test
  (4 cases including remix / distinct-ISRC guard).
- **Notes for future phases:**
  - `drizzle-kit` bumped to `^0.31` so generate works under TS `target: ES2023`.
  - Tests require a working Docker daemon (testcontainers spins up
    `pgvector/pgvector:pg16`); CI sets `TESTCONTAINERS_RYUK_DISABLED=true`.
  - Spotify `/v1/recommendations` and `/v1/audio-features` were retired for
    apps registered after 2024-11-27. The code paths are present but degrade
    silently to empty / no-op for new apps; Phase 3+ may need a handcrafted-
    features fallback.

## Phase 3 — Embedding + bucketing

- **Status:** review
- **Branch:** `phase-3-bucketing`
- **PR:** https://github.com/hanscl/crate-digger/pull/4
- **Scope landed:** 64-dim embedding builder (6 audio dims and 58-slot
  genre multi-hot taxonomy, plus `derivePrimaryGenre` and cosine similarity)
  in `src/lib/embedding.ts`; pure Welford helpers (`updateCentroid`,
  `addFeatureSample`, `featureVariance`) in `src/lib/bucketing/centroid.ts`;
  transactional spawn-or-join assignment with primary-genre filter in
  `src/lib/bucketing/assign.ts`; cold-start seeding in
  `src/lib/bucketing/cold-start.ts` (track-IDs entry point and a
  Spotify-playlist-URL wrapper that reuses the Phase 2 enrichment pipeline).
  `assignTrack` runs the entire decision (membership probe, candidate
  fetch, spawn-or-join, centroid math, writes) in one transaction, takes
  a `SELECT … FOR UPDATE` on the chosen bucket when joining, and relies
  on a unique index on `bucket_member.track_id` (migration `0001_*`) to
  detect race-losers; the outer call retries once on a unique-violation.
  Tests: pure embedding/centroid suites plus a testcontainers
  `assign.test.ts` covering the four contract cases (within-threshold
  join, outside-threshold spawn, no-genre-match spawn, Welford
  correctness), idempotency, and two concurrency regressions (parallel
  calls for the same track collapse to one membership; parallel joins
  to the same bucket round-trip the centroid and member count
  correctly). 55 tests total.
- **Notes for future phases:**
  - pgvector stores `real` (float32); centroid precision tops out around
    6-7 decimals when round-tripped through the DB. Keep that in mind when
    Phase 4 ranking math compares persisted vs in-memory vectors.
  - Spawned bucket names default to `"<primaryGenre> (auto)"`. The Phase 6
    Mastra `bucket-namer` agent is expected to overwrite these on spawn.
  - `assignTrack` uses `app_config.spawnThreshold` (default 0.7) when no
    explicit option is passed; tests force the value for determinism.

## Phase 4 — Ranking + surfacing

- **Status:** review
- **Branch:** `phase-4-ranking`
- **PR:** https://github.com/hanscl/crate-digger/pull/5
- **Scope landed:** pure refill ranker (`src/lib/ranking/refill.ts`) — `score
= mean cosine(c, keep_i) − λ · mean cosine(c, dislike_i)`; broad classifier
  (`src/lib/ranking/broad.ts`) — hand-rolled batch logistic regression on the
  64-dim embedding with L2 reg, untrained-fallback to a class prior so
  surfacing works on day 0; model versioning (`src/lib/ranking/version.ts`)
  with `bumpModelVersion`, `ensureActiveModelVersion`,
  `getActiveModelVersion`, `getActiveConfig`, lineage walker — independent
  refill/broad version chains, `parent_id` lineage, `app_config.active_*`
  pointers swung in a single transaction; surfacing pipeline
  (`src/lib/surfacing/pipeline.ts`) — novelty knob mixes refill/broad quotas,
  daily cap + queue ceiling enforced HERE (Constraint #5), source-mix
  bookkeeping as soft preference (never a hard filter), refill phase
  round-robins across refillable buckets and surfaces top-1 per slot;
  surface_event writer (`src/lib/surfacing/log.ts`) — every surface_event
  records the FULL candidate pool with sub-scores (Constraint #2 — the eval
  substrate). 25 new tests across `tests/ranking/{refill,broad}.test.ts`,
  `tests/surfacing/{pipeline,log}.test.ts`: refill/broad math (pure), Welford
  log of constraints (eval substrate, soft penalty, daily cap at surfacing,
  counterfactual replay determinism within float32 tolerance, model_version
  attribution). 80 tests total, all green.
- **Notes for future phases:**
  - Refill keeps = bucket members (cold-start seeds count as anchors). When
    Phase 5 lands explicit keep ratings, narrow `loadKeepEmbeddingsForBucket`
    to "members with explicit keep ratings"; the function shape stays.
  - Broad classifier serializes weights into `model_version.config` as
    `{weights, bias, trainedSampleCount, prior}`. Phase 5's retrain workflow
    calls `trainBroadClassifier` then `bumpModelVersion(db, "broad", config)`.
  - Counterfactual replay reproduces persisted scores within ~1e-5 due to
    pgvector's float32 storage; all replay tests use `toBeCloseTo(_, 5)`.
  - `runSurfacingBatch` accepts a candidate pool from the caller — Phase 6's
    `dailyPipeline` workflow chains ingestion → surfacing without surfacing
    reaching back into ingestion.
  - `ensureActiveModelVersion` is the single bootstrap seam — it
    idempotently mints initial `model_version` rows on first surfacing run
    and updates `app_config.active_*_version_id` pointers.

## Phase 5 — Feedback + evals

- **Status:** review
- **Branch:** `phase-5-feedback`
- **Scope landed:** rating ingestion (`src/lib/feedback/ingest-rating.ts`)
  — Constraint #3 attribution by reading `surface_event.model_version_id`
  pinned at surface time, falls back to active broad version for
  cold-start / import paths, increments `bucket.dislikeCount` only on
  dislike of a bucket member; broad retrain entrypoint
  (`src/lib/feedback/retrain.ts`) — pulls keep/dislike samples in a window,
  short-circuits `no_samples` and `single_class` cases without polluting
  the version chain, otherwise calls `trainBroadClassifier` +
  `bumpModelVersion("broad", ...)` with training-window stamps; merge/split
  recommendation heuristics (`src/lib/bucketing/recommendations.ts`) — same-
  primary-genre cosine ≥ `mergeThreshold` for merges, dislike rate ≥
  `splitDislikeRate` AND member count ≥ 4 for splits, idempotent dedupe by
  (kind, sorted bucketIds), never auto-applies (Constraint #7); eval
  metrics (`src/lib/evals/metrics.ts`) — `keepRate` (overall + by ranker /
  version / source with two-query design avoiding cross-source double
  counting), `precisionAtN` over N most recent surfaced events,
  `bucketPurity` = 1 − dislikeRate, `genreEntropy` (Shannon, raw + ln(k)
  normalized), `loadKpis` aggregate; counterfactual replay
  (`src/lib/evals/counterfactual.ts`) — re-scores historical
  `surface_event.candidate_pool` rows under a target version's config,
  reports per-event agreement vs original winner + agreement-rate +
  agreed-and-kept / disagreed-and-disliked counters, hard cap on event
  scan size (default 500). Schema additions: `RatingDecision`,
  `RecommendationKind`, `RecommendationStatus`, `BucketRecommendation`
  type exports.
  Tests (32 new, 112 total green): `tests/feedback/ingest-rating.test.ts`
  (5 cases — Constraint #3 attribution across a mid-flight retrain,
  active-version fallback, missing-event guard, dislike counter on
  member, no-op on keep / non-member); `tests/feedback/retrain.test.ts`
  (3 cases — no-samples + single-class skip, balanced retrain bumps
  version with weights set); `tests/bucketing/recommendations.test.ts`
  (6 cases — merge same-genre, no merge across genre, merge idempotency,
  split high dislike rate, no split for tiny buckets, split idempotency);
  `tests/evals/metrics.test.ts` (5 cases — keep-rate by ranker/source/
  version, P@N kept count, P@N empty, bucket purity math, genre entropy
  zero/uniform); `tests/evals/counterfactual.test.ts` (3 cases — same-
  version full agreement at cap=1, weight-shift produces different
  winner with agreementRate < 1, kind mismatch yields zero replayed).
- **Notes for future phases:**
  - `retrainBroad` reads ratings unconditionally from the global pool
    (it learns the user's CURRENT taste) — Constraint #3 only governs
    eval attribution, not training-set selection. Phase 6's daily cron
    calls `retrainBroad(db)` directly; the Console "Retrain now" button
    in Phase 7 wraps the same entrypoint.
  - `counterfactualReplay` re-runs the ranker top-1-per-event; the
    surfacing pipeline is top-K. The same-version sanity test pins
    `dailyCap=1` on purpose — at higher caps, replay-vs-pipeline rank-
    vs-pick gap is inherent (the Analyzer screen will model both views).
  - Refill replay rebuilds the keep set from the bucket's CURRENT members
    (we don't snapshot membership at surface time). That drift is
    accepted — the question replay answers is "what would the new
    ranker do TODAY against this pool", not "what would it have done at
    the original surface moment."
  - `evaluateBucketRecommendations` is currently called manually
    (admin trigger). Phase 6 will likely fan it out from the daily
    cron alongside retrain.

## Phase 6 — Mastra

- **Status:** pending

## Phase 7 — Frontend screens

- **Status:** pending

## Phase 8 — Deploy

- **Status:** pending
