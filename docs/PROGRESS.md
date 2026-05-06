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
- **PR:** https://github.com/hanscl/crate-digger/pull/7
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

- **Status:** review
- **Branch:** `phase-6-mastra`
- **PR:** https://github.com/hanscl/crate-digger/pull/8
- **Scope landed:** Mastra wiring on top of the deterministic core.
  `@mastra/core` 1.31 + `mastra` 1.7 CLI + `@ai-sdk/anthropic` 3 +
  `node-cron` 4. Three agents (`src/mastra/agents/{bucket-namer,
why-surfaced, playlist-parser}.ts`) on `anthropic/claude-haiku-4-5`
  with structured Zod output and a deterministic local fallback for the
  no-key / network-error case — bucket naming never blocks bucketing,
  why-surfaced always has copy, playlist parser falls back to a regex
  extractor. Daily workflow (`src/mastra/workflows/daily-pipeline.ts`)
  composed of five `createStep` calls (`pull-and-enrich`,
  `bucket-and-name`, `retrain-broad`, `recommendations`, `surface`),
  threaded as a Zod accumulator through `.then(...)` so each step both
  consumes and emits the same shape. Pure step bodies live in
  `src/mastra/lib/pipeline-steps.ts` (testable without Mastra in the
  loop). Per-run dependencies (`db`, `env`) flow through Mastra
  `RequestContext` via `src/mastra/runtime.ts` (no module-state
  globals). `src/mastra/index.ts` registers all agents + the workflow
  on a single `Mastra` instance with a `ConsoleLogger`. In-process
  `node-cron` (`src/server/cron.ts`) schedules `daily-pipeline` at
  03:00 server-local plus a 6-hour keepalive heartbeat; both can be
  disabled via `CRON_DISABLED=1` (test + reduced-env path) without
  losing the manual `runDailyPipelineNow()` entrypoint that Phase 7's
  Console "Run now" button will call. `src/server/index.ts` boots
  cron on startup and stops it on SIGTERM/SIGINT. `pnpm dev` now runs
  three concurrent processes (api, web, mastra) so `mastra dev` Studio
  is available at `localhost:4111`. `.env.example` documents the new
  `CRON_DISABLED` toggle.
  Tests (12 new, 124 total green): `tests/mastra/agents.test.ts`
  (8 cases — fallback names, null-genre placeholder, refill /
  broad-explore explanations, hyphen / "by" / blank-line / empty
  parser inputs); `tests/mastra/daily-pipeline.test.ts` (2 cases — a
  step-by-step run with a fixture adapter pulling 3 RawCandidates
  through pull → enrich → bucket → retrain → recommend → surface and
  asserting every surface_event row carries the FULL candidate pool
  (Constraint #2), plus a Mastra-orchestration smoke that runs the
  workflow via `mastra.getWorkflow('dailyPipeline').createRun().start()`
  and asserts the typed accumulator schema is fully populated even
  with zero candidates).
- **Notes for future phases:**
  - Mastra 1.31 renamed `runtimeContext` → `requestContext`; step
    `execute` callbacks read deps via `getDb(rc) / getEnv(rc)` from
    `src/mastra/runtime.ts`. The cast at the cron entry point is the
    only place we re-cross the typed/opaque boundary.
  - The orchestration smoke runs the workflow with the production
    adapter registry (`createDefaultRegistry().available(env)`); with
    a fixture env that exposes no API keys, no adapters are available
    and the pull step's `pulledCount` is 0. Phase 7 (or any future
    test that wants the workflow to pull fixture data) should plumb
    a fixture-adapter override through `requestContext` rather than
    monkey-patching the registry.
  - Agents currently fall back to deterministic placeholders when
    `ANTHROPIC_API_KEY` is unset. The structured-output schemas
    (`NAME_SCHEMA`, `EXPLANATION_SCHEMA`, `PARSE_SCHEMA`) are the
    contracts Phase 7's tRPC routers should validate against when
    surfacing agent output to the UI.
  - `node-cron` schedule is per-server-process; horizontal scale (Tier 3
    Fly multi-instance) would double-fire the daily run. Single-VM
    deploys are unaffected; the README in Phase 8 should call this out.

## Phase 7 — Frontend screens

- **Status:** review
- **Branch:** `phase-7-frontend`
- **PR:** https://github.com/hanscl/crate-digger/pull/9
- **Scope landed:** all 6 screens wired against tRPC and the deterministic
  core. tRPC app router gains `queue`, `buckets`, `evals`, `params`,
  `pipeline`, `sources`, `setup`, `taste` routers (plus the existing `me` /
  `ping`). Shared SVG primitives live in
  `src/web/components/primitives/{knob,fader,led-meter,radar,scope,
time-series,album-art,source-pill,feature-bar}.tsx` — pure React, no chart
  deps. Login screen + auth-aware shell gates every screen behind the
  cookie-auth `me` check; `LoginScreen` posts to `/api/auth/login` and the
  rest of the app boots once `me.authenticated` flips. Queue (#01) walks
  oldest-first unrated `surface_event` rows, exposes J/K/L keyboard rates,
  pulls why-surfaced text from the agent (deterministic fallback when
  `ANTHROPIC_API_KEY` is unset). Buckets (#02) renders a list+detail layout
  with rename, recommendation accept/dismiss, recompute trigger, and a
  centroid radar. Analyzer (#03) shows keep-rate/P@10/P@25/genre-entropy
  KPIs, a daily keep-rate spark, bucket purity column, and a
  counterfactual-replay table that re-ranks historical pools under any
  selected broad version (Constraint #2 payoff). Console (#04) commits
  knob+fader changes to `app_config` and bumps the refill `model_version`
  whenever lambda actually changes (Constraint #3); "Run pipeline now" /
  "Retrain broad classifier" buttons fan out to `pipeline.runNow`
  (Mastra `dailyPipeline`) and `pipeline.retrainNow` (`retrainBroad`).
  Sources (#05) lists every registered adapter with availability + enabled
  state, lets the user toggle `app_config.sources_enabled` and run a one-off
  `testFetch` (logged as a `search_run` row). Setup (#06) reports config
  health + counts, runs the cold-start playlist seeder
  (`seedBucketsFromSpotifyPlaylist`), and provides taste profile
  export/import — Constraint #8: `src/lib/taste/{schema,export,import}.ts`
  serialise buckets + ratings (centroids recomputed on import, ratings
  attribute to active broad version via the cold-start path), with a
  testcontainers round-trip test pinning the contract.
  Tests: 3 new in `tests/taste/round-trip.test.ts` (full round-trip through
  JSON wipe-and-restore, Zod boundary rejection, ISRC-match-not-duplicate
  guard); 115 lib/agent tests still green via the non-Docker subset
  (`embedding`, `centroid`, `schema`, `mastra/agents`, `ranking/refill`,
  `ranking/broad`, `ingestion/adapter-contract` = 70 tests). The 8
  Docker-only test files unchanged.
- **Notes for future phases:**
  - Mastra Studio sidecar runs as a separate `pnpm dev:mastra` process
    (`localhost:4111`); the Console screen links there directly. Phase 8
    needs to decide whether to ship Studio in the production Docker image
    (recommend off-by-default, behind same auth as the SPA).
  - The Buckets screen accepts merge recommendations via
    `buckets.accept` (folds member B into A, rebuilds centroid). Splits are
    emitted by the heuristic but NOT auto-applied — a richer interactive
    splitter is left for a follow-up; the MVP surfaces split as an
    actionable "this bucket is impure" signal only.
  - `taste.import` blocks duplicate buckets via no schema constraint; if
    the user re-imports the same export, ratings are duplicated (every
    rating row is unique by id). Encourage wiping before re-import.
  - `queue.next` returns winner-only sub-scores, not the full pool — the
    Queue screen's Scope viz currently shows just the winner. Adding the
    full pool to that response is a one-liner if the demo wants the
    distribution visible.
  - `sources.testFetch` mode inference is naive (splits the search query
    on " — " when mode=similar). Good enough for a smoke test; the daily
    pipeline does not use this path.

## Phase 8 — Deploy

- **Status:** review
- **Branch:** `phase-8-deploy`
- **PR:** https://github.com/hanscl/crate-digger/pull/10
- **Scope landed:** Tier 3 cloud deploy. `fly.toml` at repo root — 512 MB
  shared-cpu-1x machine, `release_command = "pnpm db:migrate"` so migrations
  gate every rollout, `/api/health` http check, force_https, rolling strategy.
  Terraform module at `infrastructure/terraform/fly/` (versions, variables,
  main, outputs, tfvars example, module README, .gitignore for state) using
  the `fly-apps/fly` provider; provisions `fly_app` + IPv6 + shared IPv4 +
  `fly_app_secret` for every secret, with empty-value filtering so unset
  optional API keys don't shadow `optional().default("")` in
  `src/server/env.ts`. Module deliberately leaves machines to `flyctl deploy`
  and Postgres to the user (Constraint #10) — README documents the four
  supported paths (Fly Postgres, Neon, Supabase, RDS) with connection-string
  formats and SSL notes. GitHub Actions deploy workflow
  (`.github/workflows/deploy.yml`): `wait-for-ci` job blocks on the existing
  `check` job, then staging deploys on push to `main` and production deploys
  on `v*` tags, each gated by a GitHub Environment (`staging` /
  `production`) so reviewers can be required in repo settings without code
  changes. CI workflow extended to run on `v*` tags so the deploy gate has
  something to wait for. Root `README.md` rewritten with three-tier deploy
  walkthrough, DB swap matrix, and CI/CD section.
- **Notes for future phases:**
  - The `fly-apps/fly` Terraform provider is community-maintained; if it
    drifts, the entire module's responsibility (app + IPs + secrets) maps
    directly onto a few `flyctl` commands documented in the module README.
  - `node-cron` runs in-process per-machine. Single-machine deploys (the
    default in `fly.toml`, `min_machines_running = 1`) are unaffected;
    horizontal scale would double-fire the daily run — solve by extracting
    cron to a separate `processes.cron = "..."` machine with
    `min_machines_running = 1` and the app machines set to 0 cron processes,
    or by introducing a Postgres advisory-lock guard around
    `runDailyPipelineNow()`.
  - Production environment uses `auto_stop_machines = "off"` so the cron
    keeps firing during quiet periods; `auto_start_machines = true` still
    handles cold-start traffic. Flip `cron_disabled = true` on staging via
    the terraform var to keep the staging machine from racing prod against
    upstream APIs.
  - Mastra Studio (`pnpm dev:mastra`, port 4111) is a development-only
    sidecar — it is not part of the production Dockerfile or `fly.toml`.
    Re-introducing it on Fly would require a second process behind the same
    cookie auth.
