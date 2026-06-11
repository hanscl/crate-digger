# Music Scout Agent — Implementation Plan

## Context

`crate-digger` is a fresh repo (only a stub README). The user has handed in a fully-specified
architecture for a self-hosted music discovery agent ("Music Scout"): two complementary discovery
modes (bucket-refill exploit + broad-discovery explore), TypeScript + Mastra, Postgres + pgvector,
tRPC over Hono, Vite/React/Tailwind/shadcn frontend co-located with the API, single-command
bootstrap via docker-compose. Spec is final on stack and constraints; the developer decides module
structure, schema specifics, ranker implementation, and test strategy. A complete UI handoff
(6 screens, studio-forward aesthetic with custom primitives — Knob, Fader, LEDMeter, Radar,
Scope, TimeSeries) is provided at `/tmp/music-scout-design/music-scout/`.

**Goal:** weekend-scope MVP that satisfies every non-negotiable constraint, doubles as meetup-demo
content, and is honest about what's stubbed so paid sources stay optional.

## Deviations from `ts-greenfield-standards` (intentional, spec-mandated)

| Standard default           | Spec choice                                                                                                       | Reason                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Cloudflare Workers compute | Long-lived Node process in docker-compose                                                                         | Self-hosted single-command bootstrap; Mastra workflows + cron need a stateful process |
| Neon Postgres              | Postgres + pgvector via docker-compose; Fly Postgres / Neon / Supabase / RDS as connection-string-pluggable swaps | "Single env var" portability across deploys                                           |
| Cloudflare Pages frontend  | Vite SPA served by the same Hono process                                                                          | Spec mandates co-location                                                             |

Standards we **keep**: pnpm, Node 24+, TypeScript strict, Oxlint, Oxfmt, Lefthook, Zod v4+,
Drizzle, tRPC, Hono, Vite, Tailwind, GitHub Actions, conventional commits.

Open architectural fork I'm resolving with a default (push back if wrong):

- **Mastra workflow visualization.** Mastra ships "Studio" bundled with `mastra dev` (port 4111).
  It's not an embeddable React widget. Plan: run `mastra dev` as a sidecar in `pnpm dev` /
  docker-compose; the dashboard's Console screen links to it. Production deploy can keep Studio
  off or behind auth. This is the meetup-demo surface; we don't reimplement it.

## Repo layout (single package, co-located UI)

```text
crate-digger/
├── docker-compose.yml              # Postgres+pgvector + app (Tier 1 bootstrap)
├── Dockerfile                      # multi-stage: build web, run server
├── .env.example                    # every required + optional key, commented
├── lefthook.yml
├── .oxlintrc.json
├── tsconfig.json                   # strict; path alias @/*
├── package.json                    # pnpm; "dev" runs server + vite + mastra in parallel
├── drizzle.config.ts
├── infrastructure/
│   └── terraform/fly/              # Tier 3 module
├── migrations/                     # drizzle-kit output
├── src/
│   ├── server/
│   │   ├── index.ts                # Hono app + tRPC mount + Vite SSR-less static serve
│   │   ├── env.ts                  # Zod-validated process.env
│   │   ├── trpc.ts                 # router init, context (db, mastra)
│   │   ├── routers/                # queue, buckets, eval, params, sources, setup
│   │   ├── auth.ts                 # single-user shared-secret middleware
│   │   └── cron.ts                 # node-cron schedule registry
│   ├── db/
│   │   ├── schema.ts               # Drizzle tables (see Data model)
│   │   ├── client.ts               # postgres-js + drizzle()
│   │   └── vector.ts               # pgvector helpers (cosine sim, HNSW index DDL)
│   ├── lib/                        # DETERMINISTIC core (no LLM, no agent)
│   │   ├── ingestion/
│   │   │   ├── adapter.ts          # Source adapter interface + registry
│   │   │   ├── spotify.ts          # free
│   │   │   ├── lastfm.ts           # free
│   │   │   └── viberate.ts         # paid, optional (no-ops if key absent)
│   │   ├── enrichment/
│   │   │   ├── resolve.ts          # ISRC-first, fuzzy fallback
│   │   │   ├── reccobeats.ts       # audio features (Spotify retired /audio-features)
│   │   │   ├── lastfm-tags.ts      # genres via Last.fm artist.getTopTags
│   │   │   ├── musicbrainz.ts      # supplementary genres via MB recording lookup
│   │   │   ├── discogs.ts          # supplementary genres + styles via Discogs
│   │   │   └── rate-limit.ts       # 2 req/s + Retry-After (ReccoBeats); also feeds MB + Discogs limiters
│   │   ├── bucketing/
│   │   │   ├── assign.ts           # genre-prior + cosine, spawn-or-join
│   │   │   ├── centroid.ts         # incremental update (Welford-style)
│   │   │   └── recommendations.ts  # merge/split heuristics
│   │   ├── ranking/
│   │   │   ├── refill.ts           # sim_to_keeps − λ·sim_to_dislikes
│   │   │   ├── broad.ts            # logistic regression P(keep|features,genre,source)
│   │   │   └── version.ts          # bump model_version on config change
│   │   ├── surfacing/
│   │   │   ├── pipeline.ts         # quality bars, queue ceiling, source-mix
│   │   │   └── log.ts              # writes surface_event w/ FULL candidate pool
│   │   ├── feedback/
│   │   │   ├── ingest-rating.ts    # incremental bucket stat updates
│   │   │   └── retrain.ts          # broad classifier retrain entrypoint
│   │   ├── evals/
│   │   │   ├── metrics.ts          # keep-rate, P@N, purity, entropy
│   │   │   └── counterfactual.ts   # replay against stored candidate pools
│   │   └── embedding.ts            # handcrafted feature vector builder
│   ├── mastra/                     # AGENTIC code only
│   │   ├── index.ts                # new Mastra({ agents, workflows, tools })
│   │   ├── agents/
│   │   │   ├── bucket-namer.ts     # lazy + drift-triggered (LAB-25)
│   │   │   ├── why-surfaced.ts     # on-demand explanation
│   │   │   └── playlist-parser.ts  # cold-start (optional)
│   │   ├── tools/                  # wraps src/lib/* + src/db/* for agent use
│   │   └── workflows/
│   │       └── daily-pipeline.ts   # ingest → enrich → rank → surface
│   └── web/                        # Vite + React + Tailwind + shadcn
│       ├── index.html
│       ├── main.tsx
│       ├── routes.tsx              # 6 screens (Queue, Buckets, Analyzer, Console, Sources, Setup)
│       ├── trpc.ts                 # @trpc/react-query client
│       ├── components/
│       │   ├── primitives/         # Knob, Fader, LEDMeter, Radar, Scope, TimeSeries, AlbumArt
│       │   ├── shadcn/             # generated shadcn pieces
│       │   └── shell/              # sidebar, health strip
│       ├── screens/                # one per spec screen
│       └── styles/                 # tokens.css ported from design handoff
└── tests/                          # vitest; testcontainers-pg
```

## Data model (Drizzle + pgvector)

Schema lives in `src/db/schema.ts`. Vector column type is `vector(N)` with HNSW index for cosine.
Embedding dim starts at **64** = 6 normalized audio features (tempo z-scored, energy, valence,
danceability, acousticness, instrumentalness) + 58-slot genre multi-hot (top-N Spotify genre
buckets, fixed taxonomy in `src/lib/embedding.ts`). Revisit dim only if eval breadth/purity sags.

| Table                   | Notes                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `track`                 | PK `id`, unique `isrc`, `spotify_id`, `mbid` (partial idx), `title`, `artist`, `album`, `release_year`, `duration_ms`, `audio_features jsonb`, `genres text[]`, `genre_sources_processed text[]` (GIN), `embedding vector(64)`, HNSW index                            |
| `track_source`          | Many-to-one from track to source provenance (`source`, `source_track_id`, `seen_at`); supports cross-source dedup                                                                                                                                                     |
| `bucket`                | `id`, `name`, `color`, `centroid vector(64)`, `feature_stats jsonb` (mean+M2 per feature for Welford), `member_count`, `dislike_count`, `created_at`, `is_cold_start_seed bool`                                                                                       |
| `bucket_member`         | `bucket_id`, `track_id`, `similarity_at_join`, `added_at`                                                                                                                                                                                                             |
| `rating`                | `id`, `track_id`, `decision enum(keep,dislike,defer,neutral)`, `model_version_id`, `surface_event_id`, `rated_at`                                                                                                                                                     |
| `surface_event`         | `id`, `track_id`, `surfaced_at`, `ranker_kind enum(refill,broad)`, `bucket_id?`, `features_at_decision jsonb`, `winner_score`, `candidate_pool jsonb` (array of `{track_id, score, sub_scores}` — **the eval substrate**), `model_version_id`, `surfaced_reason text` |
| `search_run`            | `id`, `source`, `params jsonb`, `started_at`, `count_pulled`, `count_surfaced`                                                                                                                                                                                        |
| `model_version`         | `id`, `kind enum(refill,broad)`, `config jsonb`, `training_window_start/end`, `trained_at`, `parent_id`                                                                                                                                                               |
| `bucket_recommendation` | `id`, `kind enum(merge,split)`, `bucket_ids int[]`, `reason jsonb`, `status enum(pending,accepted,dismissed)`                                                                                                                                                         |
| `app_config`            | Singleton row: novelty knob, source mix, refill/broad quality bars, queue ceiling, pull throttle, artist-diversity caps (LAB-73), retrain cadence, source toggles                                                                                                     |

Drizzle migrations via `drizzle-kit`. `pgvector` extension created in an idempotent
`migrations/0000_init.sql`.

## Implementation per concern

### 1. Ingestion (`src/lib/ingestion/`)

```ts
interface SourceAdapter {
  readonly id: "spotify" | "lastfm" | "viberate" | string;
  readonly isPaid: boolean;
  isAvailable(env: Env): boolean; // false → adapter is skipped, system still runs
  pullCandidates(params: PullParams): Promise<RawCandidate[]>;
}
```

Registry in `adapter.ts` reads enabled adapters from `app_config.sources`. Adding a new source =
new file + registry entry. Viberate's `isAvailable` returns false when `VIBERATE_API_KEY` is
unset — the system fully runs on Spotify + Last.fm.

### 2. Enrichment

`resolve.ts` keys on ISRC; falls back to normalized `(artist, title)` fuzzy match
(`fast-fuzzy` library) with a similarity threshold. Idempotent: re-running on the same
`RawCandidate` produces zero new tracks (upsert by ISRC, deterministic merge of source
provenance into `track_source`).

**Audio features** come from **ReccoBeats** (`reccobeats.ts`), not Spotify — Spotify
retired `/audio-features` for apps registered after 2024-11-27 (see `docs/SOURCES.md`).
ReccoBeats is a free, no-auth API keyed by Spotify track id; the enricher is rate-limited
(2 req/s, batches of 5, `Retry-After` honoured — `rate-limit.ts`) and toggleable via
`app_config.sources_enabled.reccobeats`. Idempotency: `audio_features IS NULL` filter.

**Genres** come from three layered sources, each gated on its own env credentials and
each optional. Tags merge additively (case-insensitive dedupe) into the unified
`track.genres: text[]`; `embedding` is rebuilt after each pass. Per-source idempotency
via `track.genre_sources_processed: text[]` — each source ID is appended after a
completed pass (success OR empty OR error). The pipeline runs in fixed order:

1. **Last.fm `artist.getTopTags`** (`lastfm-tags.ts`) — the baseline. Per-artist cache
   collapses N tracks-by-one-artist to a single call within a run. Primary-artist split
   handles Spotify's comma-joined credits. "Various Artists" is skipped (still flagged).
2. **MusicBrainz `/recording/{mbid}?inc=genres+tags`** (`musicbrainz.ts`) — recording-
   level signal where Last.fm artist-only collapses. MBID resolution: `track.mbid` →
   else Last.fm `track.getInfo` (cached on the row) → else mark+skip. 1 req/s per MB
   policy. Requires `MUSICBRAINZ_CONTACT_EMAIL` for the User-Agent.
3. **Discogs masters/releases** (`discogs.ts`) — coarse genres + the useful styles
   sub-genre layer. Master-first search/fetch, falls back to release. 50/min paced
   under the 60/min auth ceiling. Requires `DISCOGS_KEY` + `DISCOGS_SECRET`.

A track missing any enrichment still ingests and buckets on partial signal. The
`audio_feature_coverage` eval metric tracks how much of the catalogue has audio
features so silent coverage loss is visible on the Console screen.

### 3. Bucketing

`assign.ts` walks: keep → primary genre → candidate buckets sharing that genre → cosine
similarity to each centroid → if max ≥ `spawnThreshold` join nearest else spawn. `centroid.ts`
applies Welford incremental update on each keep/dislike (no full recompute). `recommendations.ts`
runs as part of feedback ingestion when thresholds tripped — writes to `bucket_recommendation`,
never auto-applies.

Bucket auto-naming is lazy (LAB-25): the `bucket-namer` agent runs in the daily-pipeline rename
step on buckets that reach N ≥ 3 members or whose centroid drifted past the rename threshold
since their last naming. Spawning a bucket just writes the deterministic `"<primary> (auto)"`
placeholder; the agent names from the aggregated member-genre distribution + centroid audio
profile, not the founding track. A `buckets.renamePlaceholders` mutation lets the user trigger
the same pass on demand from the Buckets screen.

### 4. Ranking & surfacing

- **Refill** (`refill.ts`): pure function `score = mean(cosine(c, keep_i)) − λ·mean(cosine(c, dislike_i))`. λ from `app_config`.
- **Broad** (`broad.ts`): logistic regression. Trained via in-process `ml-logistic-regression`
  (or hand-rolled gradient descent — small dataset). Trained model serialized to
  `model_version.config`. Genre dislikes = additive negative coefficient on genre features (soft
  penalty, never hard exclusion — enforced by tests).
- **Surfacing** (`surfacing/pipeline.ts`): given today's candidate pool, applies per-ranker
  quality bars (refill keep-similarity + broad P(keep)) and the source-mix ratio, bounded by the
  queue ceiling (LAB-53). Writes
  `surface_event` with `candidate_pool` = ENTIRE scored pool (winners + losers). This is
  non-negotiable per Constraint #2 — there's a unit test asserting `candidate_pool.length ≥
surfaced_count`.

Every config or model change in `app_config` triggers `model_version.bump()` (`ranking/version.ts`).
Subsequent ratings tag that version.

### 5. Feedback & evals

- `ingest-rating.ts` writes the rating, applies Welford to bucket stats, evaluates merge/split
  heuristics, enqueues retrain if cadence reached.
- Daily cron (`src/server/cron.ts`) runs broad classifier retrain at 03:00 local — calls into
  Mastra `daily-pipeline` workflow.
- Eval metrics (`evals/metrics.ts`): keep-rate by source/reason/version, P@N, bucket purity
  (within-bucket dislike rate), genre entropy. Materialized into a `daily_metrics` view (or
  tableless tRPC procedure that computes on demand for the small data scale).
- `counterfactual.ts`: replays a target `model_version` against historical `surface_event.candidate_pool`
  rows to compute "would-have-surfaced" deltas. Drives the Analyzer screen's counterfactual table.

## Mastra integration

`src/mastra/index.ts`:

```ts
export const mastra = new Mastra({
  agents: { bucketNamer, whySurfaced, playlistParser },
  workflows: { dailyPipeline },
  tools: { ...sourceTools, ...spotifyTools, ...dbTools },
});
```

- Agents use `model: 'anthropic/claude-haiku-4-5'` for naming/explanations (cheap, fast); Sonnet
  4.6 only if eval shows quality issues. `ANTHROPIC_API_KEY` from env.
- Workflow `dailyPipeline` chains deterministic steps that call `src/lib/*` — Mastra is just
  orchestration, no LLM in the hot path.
- tRPC procedures import `mastra` directly: `mastra.getWorkflow('dailyPipeline').createRun().start({ inputData })`.
- Scheduling via `node-cron` in `src/server/cron.ts` — triggers workflow runs and retrain. (No
  Inngest, no Temporal.)
- `mastra dev` runs as a `concurrently` sidecar in `pnpm dev`. The Console screen has a "Open
  Mastra Studio" link to `localhost:4111`.

## Frontend (`src/web/`)

- React 19 + Vite + Tailwind + shadcn/ui scaffolded with `pnpm dlx shadcn@latest init`.
- `tokens.css` ported verbatim from `/tmp/music-scout-design/music-scout/project/tokens.css` —
  electric cyan accent (`#22d3ee`), near-black surfaces, IBM Plex Sans/Mono via `@fontsource`.
- Custom primitives in `src/web/components/primitives/` re-implement the design's `Knob`,
  `Fader`, `LEDMeter`, `FeatureBar`, `Radar`, `Scope`, `TimeSeries`, `AlbumArt`, `SourcePill`
  (the design handoff's `primitives.jsx` is the visual reference; we rewrite cleanly in TS, not
  copy-paste).
- 6 screens map 1:1 to the handoff (Queue, Buckets, Analyzer, Console, Sources, Setup).
- Data via `@trpc/react-query`. `superjson` for Date/bigint transport. Routers:
  - `queue` — `next`, `rate`, `defer`
  - `buckets` — `list`, `detail`, `rename`, `merge`, `split`, `delete`, `recommendations`
  - `evals` — `kpis`, `timeseries`, `bucketPurity`, `counterfactualReplay`
  - `params` — `get`, `update`
  - `sources` — `list`, `toggle`, `reauth`, `testFetch`
  - `setup` — `connectSpotify`, `parsePlaylist`, `status`
  - `export` — `taste`, `import` (Constraint #8: portable JSON)
- Auth: shared-secret cookie (`ADMIN_PASSPHRASE` env). `/login` page, signed cookie set by Hono
  middleware. Single-user system — keeps it boring.

## Cold start

`screen-sources-setup.jsx` flow:

1. Connect Spotify (OAuth PKCE, refresh token in DB).
2. Optional: paste Spotify playlist URL → `mastra.getAgent('playlistParser')` parses it (or just
   call Spotify API directly and pass tracks through enrichment + bucketing as if each were a
   keep). Resulting buckets get `is_cold_start_seed = true` and a "cold-start" badge in the UI.
3. Skip → broad-discovery only until first keeps create buckets organically.

## Deploy paths

- **Tier 1 (local):** `pnpm install && docker compose up` — Postgres+pgvector + app + mastra-dev.
- **Tier 2 (single VM):** same `docker-compose.yml` on any Linux box; README documents pointing
  the Postgres env var elsewhere if desired.
- **Tier 3 (Fly.io):** `infrastructure/terraform/fly/` provisions app + Fly Postgres (or the
  user supplies a Neon/Supabase/RDS connection string). Env var `DATABASE_URL` is the single
  swap point — Constraint #10.

## Bootstrap & DX

- `pnpm dev` = `concurrently` runs Hono server (`tsx watch src/server/index.ts`), Vite
  (`vite --port 5173`), and `mastra dev`. Hono proxies `/` to Vite in dev.
- `pnpm check` = `oxlint . && oxfmt --check .`; `pnpm typecheck` = `tsc --noEmit`. Both run via
  Lefthook pre-commit (parallel). Conventional-commit guard on commit-msg.
- `.env.example` covers every key with comments: `DATABASE_URL`, `ADMIN_PASSPHRASE`,
  `ANTHROPIC_API_KEY`, `SPOTIFY_CLIENT_ID/SECRET`, `LASTFM_API_KEY`, `VIBERATE_API_KEY`
  (optional, marked).

## Phased delivery (PR-per-phase, reviewed before merge)

Each phase ships as its own feature branch + PR. Workflow per phase:

1. `git checkout main && git pull`
2. `git checkout -b phase-N-<slug>` (e.g. `phase-2-ingestion`)
3. Implement scope below; CI on every push runs `pnpm check && pnpm typecheck && pnpm test`.
4. `gh pr create` against `main` with the phase brief in the body (copied from this plan, plus
   any deviations decided mid-phase).
5. User reviews on GitHub; assistant addresses feedback in fix commits on the same branch until
   clean.
6. Squash-merge to main. **No phase merges itself.** No phase starts before the previous PR is
   merged.
7. Update `docs/PROGRESS.md` (see Context management) — tick the phase, note any plan
   amendments, link the merged PR.

Phase scopes:

1. **Skeleton + DB.** Repo scaffold, oxlint/oxfmt/lefthook, docker-compose with Postgres+pgvector,
   Drizzle schema & first migration, Hono+tRPC hello, Vite shell with sidebar + tokens.css.
   Land `docs/PLAN.md` + `docs/PROGRESS.md` in this PR.
2. **Ingestion + enrichment.** Spotify + Last.fm adapters, ISRC resolver, Spotify audio-features
   fetch, idempotency tests. Viberate adapter scaffolded but stubbed.
3. **Embedding + bucketing.** Feature vector builder, Welford centroid, spawn/join logic, cold-start
   playlist parsing path.
4. **Ranking + surfacing.** Refill ranker, broad classifier with retrain command, surfacing
   pipeline with caps/novelty, **`surface_event` candidate-pool logging** with the unit test that
   guards Constraint #2.
5. **Feedback + evals.** Rating ingest, incremental bucket stats, daily metrics, counterfactual
   replay, recommendation heuristics.
6. **Mastra.** `dailyPipeline` workflow, three agents, node-cron registration. `mastra dev` sidecar.
7. **Frontend screens.** Implement all 6 screens against tRPC, wire primitives, taste export/import.
8. **Deploy.** Fly.io terraform module, README docs for Neon/Supabase/RDS swaps, GitHub Actions CI
   (already running per-phase by this point — final phase formalizes staging/tag-based prod gate).

## Context management strategy

Goal: keep the assistant's context small per phase but never lose the plan's intent.

- **`docs/PLAN.md`** lands in Phase 1 — it IS this file, copied into the repo. Canonical reference.
  Updated only when scope changes (in a PR, with reasoning).
- **`docs/PROGRESS.md`** is the phase tracker — a checklist with one entry per phase: status,
  PR link, completion date, any plan-amending notes the assistant should know in future phases.
  Lands in Phase 1, updated at the end of every phase.
- **`CLAUDE.md`** at repo root contains a 30-line summary of the stack + non-negotiable
  constraints (Source-adapter interface, surface-event candidate-pool, model-version bumps, soft
  dislikes, Postgres-via-single-env-var, etc.). Auto-loaded by Claude Code in every session, so a
  fresh window starts pre-anchored. Lands in Phase 1.

Per-phase session protocol:

1. After each merged PR: `/clear` the conversation. Discard prior phase context entirely.
2. Open a fresh session in the repo. CLAUDE.md auto-loads.
3. First message: "Implement Phase N from `docs/PLAN.md`. Read `docs/PROGRESS.md` for state."
   The assistant reads those two files plus any phase-relevant code from prior phases and starts
   work. Nothing else is needed in context.
4. If mid-phase the conversation grows large, use `/compact` rather than `/clear` (preserves
   working state).

This keeps every phase's context bounded by `PLAN.md` (~600 lines) + `PROGRESS.md` (small) +
the actual code being touched. The plan stays authoritative; conversation history is disposable.

## Critical files to land

- `src/db/schema.ts` (data model is non-obvious; needs review before Phase 2 starts)
- `src/lib/ingestion/adapter.ts` (interface shape locks down all sources)
- `src/lib/surfacing/log.ts` + its test (the eval substrate guarantor)
- `src/lib/ranking/version.ts` (model versioning correctness)
- `src/mastra/index.ts` (Mastra wiring)
- `src/server/index.ts` + `src/server/trpc.ts` (Hono+tRPC mount)
- `docker-compose.yml`, `Dockerfile`, `.env.example` (Constraint #9 + #10)

## Testing strategy

Targeted coverage. Tests are added where they catch a specific class of bug otherwise hard to
detect, not for coverage's sake. This section supersedes the brief test list previously in
Verification.

### Principles

- **No retrofit-to-shape testing.** Tests that describe what the code currently does — rather
  than what it should do — give false confidence. Skip them.
- **No full TDD.** Implementation is in flight. Tests are added at well-defined seams, not
  driving design.
- **Tests guard contracts and constraints**, not implementation details. A test that breaks on
  every refactor is a liability.
- **Evals replace unit tests for tunable logic.** Anything tuned as the system learns (ranker
  scoring, similarity weights) is governed by eval metrics over time, not pinned by tests.

### Required coverage

#### 1. Eval substrate — highest priority (lands Phase 4)

If `surface_event` logging is broken, every downstream eval is silently wrong. The dashboard
keeps drawing charts; the data is corrupt. Worst class of bug in the system.

- Surface event captures the full candidate pool with scores, not just the surfaced winner.
- Scores recorded in the surface event match what the ranker produced for the same inputs.
- `model_version` is correctly attributed to every surface event.
- Counterfactual replay: given a historical candidate pool, re-running the ranker at that
  pool's `model_version` produces the same ranking originally recorded.

#### 2. Bucketing assignment (lands Phase 3)

A track joining the wrong bucket corrupts that bucket's centroid; corruption compounds with
every subsequent assignment. Visual review won't catch subtle mis-assignments.

Fixture-based cases covering the hybrid algorithm's decision points:

- Track within spawn threshold of an existing bucket joins that bucket.
- Track outside spawn threshold of all candidates spawns a new bucket.
- Track with no genre match against any existing bucket spawns regardless of embedding similarity.
- Centroid update on join produces the expected new centroid (Welford correctness).

These tests pin the algorithm's contract (input → assignment), not the implementation. The one
place retrofitting is appropriate, because the contract is stable even as internals change.

#### 3. Source adapter contract (lands Phase 2)

The open-source promise requires the system to run on free-tier sources only. A contributor
adding a new adapter that subtly breaks degraded-mode behavior won't be caught by manual review.

A single contract test file run against every registered adapter:

- Adapter implements the common `SourceAdapter` interface.
- Adapter handles missing credentials gracefully — returns empty / degraded result, does not throw.
- Rate-limit and error responses don't crash the ingestion pipeline.

Adding adapters → contract test runs against them automatically. No per-adapter test duplication.

#### 4. Constraint guards (across phases)

Direct assertions of the non-negotiable constraints listed in `CLAUDE.md` and the spec. Each
guard catches refactors that accidentally violate documented constraints.

- **Soft penalties, not hard filters** (Constraint #4 — Phase 4): given a user has disliked
  genre X, candidates of genre X still appear in the candidate pool with reduced scores. They
  are not excluded.
- **Pull throttle + quality bar + queue ceiling enforced at surfacing, not ingestion**
  (Constraint #5, amended LAB-53): ingestion captures all candidates; surfacing emits every
  candidate that clears its ranker's quality bar, bounded only by the queue ceiling
  (`max(0, queueCeiling − unrated)`). The per-run pull size (LAB-51) is the throttle.
  Keep/dislike/neutral-decided and pending-unrated tracks are excluded at surfacing entry (amended
  LAB-60/LAB-76); defer re-surfaces (`neutral` settles the track but carries zero taste signal).
  Artist diversity (amended LAB-73): the similar pull is capped
  per-artist (+ skips artists with ≥N keeps), and surfacing emits at most N tracks per artist
  per run; overflow stays enriched-but-unsurfaced. Novelty scales the refill familiarity
  penalty and is version-frozen (Constraint #6, amended LAB-73 — a novelty change bumps the
  refill `model_version`).
- **Enrichment idempotency** (Phase 2): running enrichment twice on the same input produces
  identical `Track` records and does not duplicate.
- **Ratings tag the surface-time `model_version`** (Constraint #3 — Phase 5): not the version
  current at rating time.

#### 5. End-to-end smoke (lands Phase 6+)

Integration territory where unit tests have low signal. One real run catches more than ten
mocked workflow tests.

A single end-to-end run with fixture source data covering ingest → enrich → bucket → rank →
surface. Asserts that a candidate makes it through every stage and lands in the queue with a
complete `surface_event` logged.

Not a full integration suite. One smoke test, runs on every CI pass.

### Not required

These would add maintenance friction without proportional value:

- **Ranker scoring math.** Will change as the system tunes. Eval metrics (precision@N, keep
  rate by version) catch regressions over time, not unit tests.
- **tRPC routes.** End-to-end types catch most of what unit tests would; manual dashboard
  exercise catches the rest.
- **Mastra workflow orchestration unit tests.** The end-to-end smoke covers this.
- **UI components.** Designer iterates; components churn. Visual review beats RTL tests at
  this scope.
- **Database schema / migrations.** Exercised constantly in dev; explicit tests would shadow
  the migrations themselves.
- **Exhaustive bucketing edge cases beyond the contract.** The fixture set above is
  sufficient; more becomes refactor friction.

### Infrastructure

- Vitest as runner. `@testcontainers/postgresql` for DB-touching tests.
- Fixture data lives in the repo. No fetching real APIs in tests.
- All categorized tests run on CI on every PR push.
- No coverage thresholds. Coverage as a number is not a goal; the targeted tests above are.

### Adding tests later

A real bug found in production-ish use is paired with a regression test only if it falls into
one of the categories above. Bugs in tunable logic get fixed; eval metrics catch the
regression, not a unit test.

## Verification

End-to-end smoke (after Phase 7):

1. `cp .env.example .env`, fill `ANTHROPIC_API_KEY` + Spotify creds, leave `VIBERATE_API_KEY` empty.
2. `pnpm install && docker compose up --build`.
3. Open `localhost:5173`, log in with `ADMIN_PASSPHRASE`. Verify dashboard renders.
4. Setup screen → connect Spotify → optionally paste a playlist URL.
5. Trigger ingestion manually from Console → tracks appear in Rating Queue with `why` text.
6. Rate ~30 tracks → Buckets screen shows ≥1 emergent bucket with auto-name and centroid radar.
7. Console: nudge novelty knob → confirm `model_version` bumps in DB; subsequent ratings tag the
   new version.
8. Analyzer: KPIs populate, counterfactual replay returns deltas against a prior version.
9. Sources: disable Spotify → ingestion logs continue from Last.fm only (Constraint #1).
10. Export taste profile JSON → wipe DB → import → buckets + ratings round-trip cleanly
    (Constraint #8).

Tests: see "Testing strategy" above for the full coverage plan and per-phase mapping.

`pnpm check && pnpm typecheck && pnpm test` — green is the gate.
