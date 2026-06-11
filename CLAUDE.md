# Crate Digger — agent context

Self-hosted music discovery agent. Two modes: bucket-refill (exploit) + broad discovery
(explore). TypeScript + Mastra. Open-source. Single-command bootstrap.

**Read `docs/PLAN.md` for the full architecture and phase plan.** For current state — what's
done, in progress, and next — **check Linear** (team **Product Lab**, project **Crate Digger**)
via the **`linear-crosby33`** skill. Then proceed.

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
   The per-run pull size (LAB-51) is the throttle. Keep/dislike/neutral-decided and pending-unrated
   tracks are excluded at surfacing entry (amended LAB-60/LAB-76); defer re-surfaces. (`neutral` =
   "seen it, indifferent" — settles the track but carries zero taste signal: no bucket commit,
   dislike counter, or λ-penalty.) **Artist diversity**
   (amended LAB-73): the similar pull is capped per-artist and skips artists with ≥N keeps, and
   surfacing emits at most N tracks per artist per run — overflow stays enriched-but-unsurfaced
   (defer-not-discard, like below-bar tracks; full pool still logged per Constraint #2).
6. **Novelty knob = ranking parameter** (amended LAB-73). It scales the refill artist-familiarity
   penalty (higher novelty ⇒ already-kept artists are downweighted harder) and is therefore
   version-frozen: changing it bumps the refill `model_version` (Constraint #3), and ratings tag
   the new version. Its originally-spec'd effects — explore/exploit weight (broad) and bucket-spawn
   aggressiveness (refill) — remain future work.
7. **Admin dashboard is read-mostly + parameter tweaks.** Writes limited to config, manual
   retrain triggers, merge/split confirmations.
8. **Taste profile portable.** Ratings + buckets exportable/importable as JSON.
9. **Single-command bootstrap.** `pnpm install && pnpm dev`. `.env.example` covers every key.
10. **`DATABASE_URL` is a single env var swap** across local docker-compose, Neon, Supabase,
    RDS, Fly Postgres — no code changes.

## Tracking — Linear is the source of record

- **Linear is the single source of record** for what's planned, in progress, decided, and done.
  Team **Product Lab** (`LAB`), project **Crate Digger**. The repo (code, git history, PR
  descriptions) records _how_; Linear records _what_ and _why_ — scope, decisions, follow-ups.
- **Always go through the `linear-crosby33` skill** to read or write Linear — resolving
  team/project/workflow-state, creating/updating issues, posting decisions or handovers. Never
  hand-roll Linear MCP calls or guess team/project/status IDs. (The skill is defined in the
  global user profile.)
- **Every PR references its LAB issue.** Branch from the issue's Linear `gitBranchName`; cite
  `LAB-NN` in the PR title/body. Net-new work without an issue is the exception — create the
  issue first (via the skill), then branch.
- **Decisions and implementation rationale live in the issue (or its PR), not a separate in-repo
  log.** `docs/PROGRESS.md` is retired — frozen for history, never appended to.

## Working agreement

- One issue per PR. Branch from the LAB issue's Linear `gitBranchName`. Open PR to `main`, citing
  `LAB-NN`. Wait for review. Address feedback. Squash-merge.
- After each merged PR: `/clear`. A fresh session reads `CLAUDE.md` (this file) + `docs/PLAN.md`,
  then checks Linear (via `linear-crosby33`) for current state and the next issue.
- Use `/compact` mid-phase if context grows large.
- Standards: greenfield TS defaults (Drizzle, Zod, oxlint, etc). Confirm before deviating.
