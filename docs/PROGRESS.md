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
- **Scope landed:** 64-dim embedding builder (6 audio dims + 58-slot genre
  multi-hot taxonomy, plus `derivePrimaryGenre` and cosine similarity) in
  `src/lib/embedding.ts`; pure Welford helpers (`updateCentroid`,
  `addFeatureSample`, `featureVariance`) in `src/lib/bucketing/centroid.ts`;
  transactional spawn-or-join assignment with primary-genre filter in
  `src/lib/bucketing/assign.ts`; cold-start seeding (track-IDs entry point
  + Spotify-playlist-URL wrapper around the Phase 2 enrichment pipeline)
  in `src/lib/bucketing/cold-start.ts`. Tests: pure embedding/centroid
  suites plus a testcontainers `assign.test.ts` covering the four contract
  cases (within-threshold join, outside-threshold spawn, no-genre-match
  spawn, Welford correctness) plus an idempotency guard. 53 tests total.
- **Notes for future phases:**
  - pgvector stores `real` (float32); centroid precision tops out around
    6-7 decimals when round-tripped through the DB. Keep that in mind when
    Phase 4 ranking math compares persisted vs in-memory vectors.
  - Spawned bucket names default to `"<primaryGenre> (auto)"`. The Phase 6
    Mastra `bucket-namer` agent is expected to overwrite these on spawn.
  - `assignTrack` uses `app_config.spawnThreshold` (default 0.7) when no
    explicit option is passed; tests force the value for determinism.

## Phase 4 — Ranking + surfacing

- **Status:** pending

## Phase 5 — Feedback + evals

- **Status:** pending

## Phase 6 — Mastra

- **Status:** pending

## Phase 7 — Frontend screens

- **Status:** pending

## Phase 8 — Deploy

- **Status:** pending
