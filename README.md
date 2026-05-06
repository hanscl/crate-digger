# crate-digger

A self-hosted music discovery agent. Surfaces new tracks for rating, learns from feedback,
organizes liked music into similarity-based buckets. Two complementary discovery modes:

- **Bucket refill (exploit)** — for each established taste cluster, find more like it.
- **Broad discovery (explore)** — surface candidates from trend sources across genres.

Built on TypeScript + Mastra. Open source. Single-command bootstrap. Paid APIs optional.

> **Status:** Phase 8 (deploy). Feature-complete; see `docs/PROGRESS.md`.

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

## Deploy

Three tiers, all driven by the same Docker image and the same single
`DATABASE_URL` swap (Constraint #10).

### Tier 1 — Local

`pnpm dev` (above) for active development. To run the full production stack
locally inside Docker:

```sh
docker compose --profile app up --build
# app on :3000, postgres on 127.0.0.1:5432
```

### Tier 2 — Single VM

Same `docker-compose.yml` works on any Linux box (Hetzner, DigitalOcean droplet,
home server). Steps:

1. `git clone` and `cp .env.example .env` on the host.
2. Set a strong `ADMIN_PASSPHRASE` (`openssl rand -hex 32`) and a strong
   `POSTGRES_PASSWORD`; update the `DATABASE_URL` to match.
3. Put a TLS-terminating reverse proxy (Caddy / Traefik / nginx) in front of
   port 3000. The auth cookie sets `Secure` only when `NODE_ENV=production`,
   which the compose `app` service already does.
4. `docker compose --profile app up -d`.
5. `docker compose exec app pnpm db:migrate` for migrations after every pull.

To point at a managed Postgres instead of the bundled one, leave the
`postgres` service running (or remove it) and just set `DATABASE_URL` on the
`app` service to the external connection string. Nothing else changes.

### Tier 3 — Fly.io

The repo ships a Terraform module + `fly.toml` + GitHub Actions workflow for
Fly deploys.

**Bootstrap (one-time):**

```sh
cd infrastructure/terraform/fly
cp terraform.tfvars.example terraform.tfvars   # fill non-sensitive values
export FLY_API_TOKEN=$(flyctl auth token)
export TF_VAR_database_url='postgres://...?sslmode=require'
export TF_VAR_admin_passphrase=$(openssl rand -hex 32)
terraform init && terraform apply
cd ../../..
flyctl deploy --remote-only --app crate-digger
```

See `infrastructure/terraform/fly/README.md` for the full walkthrough and a
two-environment (staging + production) layout.

**Subsequent deploys** flow through GitHub Actions
(`.github/workflows/deploy.yml`):

- `push` to `main` → staging app (`crate-digger-staging`)
- `git tag v*.*.* && git push --tags` → production app (`crate-digger`),
  gated by the GitHub `production` environment (configure required reviewers
  in repo Settings → Environments to add a manual approval gate)

Both jobs wait for the CI `check` job to pass on the same SHA before
running. Configure two repository secrets, generated with
`flyctl tokens create deploy -a <app-name>` so each is scoped to a single
app and a leak in one environment cannot reach the other:

- `FLY_API_TOKEN_STAGING` — for `crate-digger-staging`
- `FLY_API_TOKEN_PRODUCTION` — for `crate-digger`

## Database — connection-string swap

Constraint #10: `DATABASE_URL` is the single env-var swap across providers.
Any Postgres 14+ with `pgvector` works. Format:

```
postgres://USER:PASSWORD@HOST:PORT/DB?sslmode=require
```

| Provider        | Notes                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Local (compose) | `postgres://cratedigger:cratedigger@localhost:5432/cratedigger` — defaults in `.env.example`           |
| Fly Postgres    | `flyctl postgres create` then `flyctl postgres attach`. Run `CREATE EXTENSION vector;` on the DB once. |
| Neon            | pgvector preinstalled. Use the pooler URL for serverless; pin a region.                                |
| Supabase        | Enable pgvector under Database → Extensions. Prefer the _pooler_ URL on Fly.                           |
| RDS             | Postgres 16. Install pgvector via the parameter group.                                                 |
| Self-hosted     | `pgvector/pgvector:pg17` is the reference image.                                                       |

`pnpm db:migrate` applies pending migrations. Run it manually after every
deploy on Tier 2; on Tier 3 the Fly `release_command` in `fly.toml` runs
migrations automatically before each release becomes primary.

## CI / CD

- **CI** (`.github/workflows/ci.yml`) — runs on every push to `main`,
  `phase-*`, tags `v*`, and PRs to `main`. Executes
  `pnpm check && pnpm typecheck && pnpm test && pnpm build`.
- **Deploy** (`.github/workflows/deploy.yml`) — staging on `main`, production
  on `v*` tags. Both wait for the CI check to pass on the same SHA.
