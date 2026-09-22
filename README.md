# crate-digger

A self-hosted music discovery agent. Surfaces new tracks for rating, learns from feedback,
organizes liked music into similarity-based buckets. Two complementary discovery modes:

- **Bucket refill (exploit)** — for each established taste cluster, find more like it.
- **Broad discovery (explore)** — surface candidates from trend and social-breakout sources
  across genres.

Built on TypeScript + Mastra. Open source. Single-command bootstrap. Paid APIs optional.

> **Status:** feature-complete and running. Current work is discovery quality — breakout-engine
> calibration and A/B (LAB-91), new-direction pulls (LAB-40), a real explore mode (LAB-160).
> Planned / in progress / done lives in **Linear** (team _Product Lab_, project _Crate Digger_).
> `docs/PROGRESS.md` is frozen history, not current state.

## Quickstart

Requires Docker, Node 24, pnpm 10.

```sh
cp .env.example .env
# Only DATABASE_URL and ADMIN_PASSPHRASE are required.
# Add SPOTIFY_CLIENT_ID/SECRET + LASTFM_API_KEY for real ingest, and
# ANTHROPIC_API_KEY for bucket naming / why-surfaced copy. Everything else
# degrades gracefully — see "Sources & enrichment" below.
pnpm install
pnpm db:init     # one-time: create pgvector extension + apply migrations
pnpm dev         # Postgres + API + Vite + Mastra Studio; app at http://localhost:5173
```

`pnpm dev` also starts `mastra dev` (Studio on `:4111`, linked from the Console screen).
`pnpm dev:stop` brings the postgres container down.

For a full cold-start walkthrough — first login, seeding taste, rating, watching buckets
emerge, verifying enrichment coverage — see `docs/RUNBOOK.md`.

## Sources & enrichment

Every source sits behind a common adapter interface (Constraint #1). A missing key means that
source is skipped, never a boot failure — the system runs fully on Spotify + Last.fm.

| Layer          | Source                                                  | Key                 | Notes                                                                                                                                    |
| -------------- | ------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ingest         | **Spotify**                                             | free app creds      | Search + metadata. Also a taste-seeded similar pull (artist+title search). Post-2024 API cliffs documented in `docs/SOURCES.md`.         |
| Ingest         | **Last.fm**                                             | free key            | Trending + `similar` pull seeded from bucket exemplars.                                                                                  |
| Audio features | **ReccoBeats**                                          | none                | Replaces Spotify `/audio-features`, retired for apps registered after 2024-11-27. Toggled on the Sources screen; rate limiting built in. |
| Genres         | **Last.fm artist tags** → **MusicBrainz** → **Discogs** | free / email / free | Layered. Artist tags alone work but are coarse; MusicBrainz recovers per-track signal; Discogs adds curated sub-genre styles.            |
| Breakout       | **Viberate**, **ChartMetric**                           | paid, optional      | Social-breakout engines — see below.                                                                                                     |

**Social-breakout engines (paid, optional).** Viberate and ChartMetric each pool social-lead
feeds (Shazam / TikTok / SoundCloud / YouTube trending) against Spotify maturity and score each
track's _breakout gap_: surging socially while still small on Spotify. That score feeds the broad
ranker as a soft mainstream down-weight (`breakoutPenalty`), never a filter. Run both to A/B
per-source keep rate on the Analyzer. With no key, both sources are skipped.

Full provider detail, spike findings and billing notes: `docs/SOURCES.md`.

## How surfacing decides

- **Ingest everything; gate at surfacing.** The per-run pull throttle
  (`trendingLimitPerSource`, `similarLimitPerSource`, `similarSeedBuckets`) bounds what gets
  pulled. Surfacing then emits every candidate clearing its ranker's quality bar —
  `refillQualityBar` (keep-similarity) or `broadQualityBar` (classifier P(keep)) — bounded only
  by the queue ceiling, `max(0, queueCeiling − unrated)`. Below-bar tracks stay enriched but
  unsurfaced; they defer, they aren't discarded.
- **Four verdicts.** <kbd>J</kbd> keep · <kbd>K</kbd> defer · <kbd>L</kbd> dislike ·
  <kbd>N</kbd> neutral. Keep, dislike and neutral settle a track; defer lets it re-surface.
  Neutral means "seen it, indifferent" — it carries zero taste signal: no bucket commit, no
  dislike counter, no λ penalty.
- **Artist diversity.** The similar pull is capped per artist (`similarArtistCap`) and skips
  artists already past `familiarArtistKeepThreshold` keeps; surfacing emits at most
  `surfaceArtistCap` tracks per artist per run. Overflow defers.
- **Soft penalties, not hard filters.** Dislikes downweight similar tracks; nothing is excluded
  outright.
- **Buckets commit on approval.** A surfaced track shows its candidate bucket but only joins it
  when you keep it.
- **Every ranking is logged.** `surface_event.candidate_pool` records the full scored pool for
  each run, not just what surfaced. That's the eval substrate the Analyzer's counterfactual
  replay runs on, for both the refill and broad chains.
- **Ranker versions are frozen.** Changing `novelty`, `refillLambda` or `audioWeight` bumps the
  refill `model_version`; `breakoutPenalty` bumps the broad chain. Ratings tag the version they
  were collected under, so before/after comparisons stay honest.

All knobs live on the Console screen, which is the only surface that mutates `app_config`.

## Stack

pnpm + Node 24 · TypeScript strict · Hono + tRPC v11 · Drizzle + Postgres + pgvector ·
Vite + React 19 + Tailwind · Mastra (workflows + 3 narrow agents) · oxlint + oxfmt + lefthook ·
docker-compose for local · Fly.io terraform for cloud.

## Layout

```text
src/server/   Hono + tRPC + auth + cron entry point
src/db/       Drizzle schema, client, pgvector helpers
src/lib/      Deterministic core (ingestion, enrichment, bucketing, ranking, surfacing,
              feedback, taste export/import, evals)
src/mastra/   Agentic code (workflows, agents, tools)
src/web/      Vite SPA — 6 screens (Queue, Buckets, Analyzer, Console, Sources, Setup)
migrations/   drizzle-kit output
scripts/      One-off probes and spike harnesses
infrastructure/terraform/fly/   Tier 3 cloud module
```

## Docs

| File               | What it covers                                                        |
| ------------------ | --------------------------------------------------------------------- |
| `docs/PLAN.md`     | Architecture spec, data model, phase plan                             |
| `docs/SOURCES.md`  | Every provider, the post-2024 Spotify cliffs, spike findings, billing |
| `docs/RUNBOOK.md`  | Cold-start build & test walkthrough, verification steps               |
| `docs/DEPLOY.md`   | The three deploy tiers + GitHub Actions hardening on a public repo    |
| `CLAUDE.md`        | Working agreement with coding agents                                  |
| `docs/PROGRESS.md` | **Retired.** Frozen history; Linear is the source of record           |

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
two-environment (staging + production) layout. Set `cron_disabled=true` on the
staging app so the daily pipeline doesn't run twice against shared upstream APIs.

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

Running this on a public fork? `docs/DEPLOY.md` covers what's already protected
(fork PRs get no secrets, SHA-pinned actions, app-scoped tokens) and the four
repository settings you still have to configure yourself.

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

`pnpm db:migrate` applies pending migrations and reconciles bucket state. Run it
manually after every deploy on Tier 2; on Tier 3 the Fly `release_command` in
`fly.toml` runs migrations automatically before each release becomes primary.

## CI / CD

- **CI** (`.github/workflows/ci.yml`) — runs on every push to `main`,
  `phase-*`, tags `v*`, and PRs to `main`. Executes
  `pnpm check && pnpm typecheck && pnpm test && pnpm build`.
- **Deploy** (`.github/workflows/deploy.yml`) — staging on `main`, production
  on `v*` tags. Both wait for the CI check to pass on the same SHA.
