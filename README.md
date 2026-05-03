# crate-digger

A self-hosted music discovery agent. Surfaces new tracks for rating, learns from feedback,
organizes liked music into similarity-based buckets. Two complementary discovery modes:

- **Bucket refill (exploit)** — for each established taste cluster, find more like it.
- **Broad discovery (explore)** — surface candidates from trend sources across genres.

Built on TypeScript + Mastra. Open source. Single-command bootstrap. Paid APIs optional.

> **Status:** Phase 1 (skeleton + DB). Most screens are placeholders. See `docs/PROGRESS.md`.

## Quickstart

Requires Docker, Node 24, pnpm 10.

```sh
cp .env.example .env
# fill ADMIN_PASSPHRASE, ANTHROPIC_API_KEY, SPOTIFY_CLIENT_ID/SECRET, LASTFM_API_KEY
pnpm install
pnpm db:init     # one-time: create pgvector extension + apply migrations
pnpm dev         # brings up Postgres + API + Vite, opens at http://localhost:5173
```

`pnpm dev:stop` brings the postgres container down.

## Stack

pnpm + Node 24 · TypeScript strict · Hono + tRPC v11 · Drizzle + Postgres + pgvector ·
Vite + React 19 + Tailwind · Mastra (workflows + 3 narrow agents) · oxlint + oxfmt + lefthook ·
docker-compose for local · Fly.io terraform for cloud.

## Layout

```text
src/server/   Hono + tRPC + auth + cron entry point
src/db/       Drizzle schema, client, pgvector helpers
src/lib/      Deterministic core (ingestion, enrichment, bucketing, ranking, surfacing, feedback, evals)
src/mastra/   Agentic code (workflows, agents, tools)
src/web/      Vite SPA — 6 screens
migrations/   drizzle-kit output
infrastructure/terraform/fly/   Tier 3 cloud module
```

See `docs/PLAN.md` for the architecture spec and phase plan, `docs/PROGRESS.md` for status,
and `CLAUDE.md` for working agreement with coding agents.

## Deploy paths

- **Local / single-VM**: `docker compose --profile app up` for the full stack on any Linux host.
- **Cloud**: `infrastructure/terraform/fly/` provisions Fly.io app + Postgres. Swap
  `DATABASE_URL` to a Neon, Supabase, RDS, or other Postgres connection string with no code
  changes.
