# Crate Digger — agent context

Self-hosted music discovery agent. Two modes: bucket-refill (exploit) + broad discovery
(explore). TypeScript + Mastra. Open-source. Single-command bootstrap.

**Read `docs/PLAN.md` for the full architecture and phase plan. Read `docs/PROGRESS.md` for
current state.** Then proceed.

## Stack

- pnpm + Node 24, TypeScript strict, oxlint + oxfmt, lefthook (parallel pre-commit), conventional commits.
- Hono + tRPC v11 (cookie-auth single-user), Vite + React 19 + Tailwind + IBM Plex (custom design tokens).
- Drizzle + postgres-js + pgvector (HNSW cosine).
- Mastra workflows + 3 narrow agents (bucket naming, why-surfaced, optional playlist parsing).
- node-cron in-process scheduler. Vitest + testcontainers-pg for tests.
- docker-compose for local + single-VM. Fly.io terraform module for cloud.

## Layout

- `src/server/` — Hono + tRPC + auth + cron entry point
- `src/db/` — Drizzle schema, client, pgvector helpers
- `src/lib/` — DETERMINISTIC core: ingestion, enrichment, bucketing, ranking, surfacing, feedback, evals (no LLM, no agent)
- `src/mastra/` — agentic code only: workflows, agents, tools wrapping `src/lib/`
- `src/web/` — Vite SPA, 6 screens (Queue, Buckets, Analyzer, Console, Sources, Setup)
- `migrations/` — drizzle-kit output
- `infrastructure/terraform/fly/` — Tier 3 cloud module

## Non-negotiable constraints (verbatim from spec)

1. **Source adapters behind a common interface.** Paid sources (Viberate) optional.
   System runs fully on Spotify + Last.fm.
2. **`surface_event.candidate_pool` logs the FULL ranking context** — every candidate's score,
   not just the surfaced track. This is the eval substrate. Never optimize away.
3. **Ranker versions are first-class.** Every ranker/config change bumps `model_version`;
   ratings tag the version under which they were collected.
4. **Soft penalties on dislikes, not hard filters.** Genre dislikes downweight; never exclude.
5. **Pull throttle + quality bar + queue ceiling enforced at surfacing layer** (amended LAB-53),
   not at ingestion. Ingest captures everything; surfacing emits every candidate that clears its
   ranker's quality bar (refill = keep-similarity; broad = classifier P(keep)), bounded only by the
   queue ceiling (`max(0, queueCeiling − unrated)`). Below-bar tracks stay enriched but unsurfaced.
   The per-run pull size (LAB-51) is the throttle. Keep/dislike-decided and pending-unrated tracks
   are excluded at surfacing entry (amended LAB-60); defer re-surfaces.
6. **Novelty knob = ranking parameter.** Affects explore/exploit weight (broad) and bucket-spawn
   aggressiveness (refill).
7. **Admin dashboard is read-mostly + parameter tweaks.** Writes limited to config, manual
   retrain triggers, merge/split confirmations.
8. **Taste profile portable.** Ratings + buckets exportable/importable as JSON.
9. **Single-command bootstrap.** `pnpm install && pnpm dev`. `.env.example` covers every key.
10. **`DATABASE_URL` is a single env var swap** across local docker-compose, Neon, Supabase,
    RDS, Fly Postgres — no code changes.

## Working agreement

- Phase-per-PR. Branch: `phase-N-<slug>`. Open PR to `main`. Wait for review. Address feedback.
  Squash-merge. Update `docs/PROGRESS.md`.
- After each merged PR: `/clear`. Fresh session reads `CLAUDE.md` (this file), `docs/PLAN.md`,
  and `docs/PROGRESS.md`, then starts the next phase.
- Use `/compact` mid-phase if context grows large.
- Standards: greenfield TS defaults (Drizzle, Zod, oxlint, etc). Confirm before deviating.
