# Deployment

Three tiers, picked by where you want the app to live. All three share the same
container image and the same `DATABASE_URL` swap point (Constraint #10 in
`PLAN.md`) — moving between them is a connection-string change, not a code
change.

## Tier 1 — Local

```sh
pnpm install
docker compose up
```

Postgres+pgvector + the app + `mastra dev` run side-by-side from
`docker-compose.yml`. Intended for development and for users who want to run
the whole thing on their laptop.

## Tier 2 — Single VM

Same `docker-compose.yml` on any Linux box you control (Hetzner, a NUC, a
spare server). Point `DATABASE_URL` at the compose-managed Postgres, or at a
managed Postgres elsewhere if you'd rather not run the DB on the VM.

No deploy automation here — `git pull && docker compose up -d --build` is the
update loop. Suitable for solo use; not recommended if you want zero-downtime
releases.

## Tier 3 — Fly.io (with GitHub Actions)

The path the CI/CD pipeline in this repo targets.

**Provisioning** — `infrastructure/terraform/fly/` owns the rarely-changing
pieces: the Fly app shell, IPs, and secrets. See its `README.md` for the
one-time setup (terraform init/plan/apply, secret env vars, optional
staging+prod workspaces).

**Database** — out of scope for the terraform module. Pick one and set
`DATABASE_URL`:

- **Fly Postgres** — `flyctl postgres create` then `CREATE EXTENSION vector;`
- **Neon** — pgvector preinstalled, copy the connection string
- **Supabase** — enable pgvector, use the pooler URL on Fly
- **AWS RDS** — Postgres 16 + pgvector via parameter group
- **Self-hosted** — anywhere you can run `pgvector/pgvector:pg17`

**Releases** — `flyctl deploy` does the per-deploy machine rollout, driven
by `.github/workflows/deploy.yml`:

- Push to `main` → deploys to `crate-digger-staging`.
- Push a `v*` tag → deploys to `crate-digger` (production), gated on the
  `production` GitHub Environment.
- Both wait for the `CI` workflow on the same SHA to pass before deploying.

Set `cron_disabled=true` on the staging app so the daily pipeline doesn't run
twice against shared upstream APIs.

---

## GitHub Actions on a public repo

The workflow YAML being public is fine — that's normal for OSS, and contributors
benefit from seeing how the project ships. The security boundary is **secrets +
who can trigger runs**, not the file itself. Here's how the current setup holds
that boundary, and what you should still verify on your fork.

### What's already protected

**Secrets are scoped and never exposed to forks.**

- `FLY_API_TOKEN_STAGING` / `FLY_API_TOKEN_PRODUCTION` are repository secrets.
  GitHub does not pass secrets to workflows triggered by PRs from forks, so a
  malicious PR cannot read them.
- Tokens are **app-scoped** (`flyctl tokens create deploy -a <app>`), not
  org-scoped. A leak compromises one app, not your whole Fly account. Staging
  and production tokens are separate, so a staging compromise can't reach prod.

**Deploy can only fire from trusted refs.**

- `deploy.yml` only triggers on push to `main` or `v*` tags. PRs (including
  fork PRs) run CI but not deploy.
- Production is gated on the `production` GitHub Environment, where you can
  configure required reviewers for a manual approval step on every tag.

**CI doesn't expose secrets to fork PRs.**

- `ci.yml` uses the default `pull_request` trigger (not `pull_request_target`),
  which runs in the fork's context without access to repository secrets.
- The check job uses no secrets — only public package registries.

**Third-party actions are pinned.**

- `deploy.yml` pins `lewagon/wait-on-check-action` and
  `superfly/flyctl-actions/setup-flyctl` to commit SHAs, not tags. A compromised
  upstream can't swap the binary running next to your deploy token.

### What you still need to configure on your fork

These are repository-level settings, not code, so they don't carry over when
someone forks the repo:

1. **Branch protection on `main`.** Without it, any collaborator with write
   access can push straight to `main` and trigger a staging deploy. Settings →
   Branches → add a rule requiring PR review before merge.
2. **Tag protection on `v*`.** By default any collaborator with write can push
   a release tag. Settings → Tags → protect `v*` so only admins can create them.
3. **Required reviewers on the `production` environment.** Settings →
   Environments → production → add yourself (or a small list) as a required
   reviewer. Tag pushes will then pause for manual approval before deploying.
4. **Restrict who can approve workflow runs from first-time contributors.**
   Settings → Actions → General → "Require approval for first-time
   contributors" (or stricter). Prevents drive-by PRs from running CI without
   your sign-off.

### What you should NOT do

- **Don't move workflows to a private repo to "hide" them.** It doesn't change
  the security model — the secrets are what matter — and it loses the
  transparency OSS contributors get from seeing how releases work.
- **Don't put secrets in the YAML or in `terraform.tfvars`.** `terraform.tfvars`
  is gitignored for this reason; secrets flow through environment variables
  (`TF_VAR_*` for terraform, GitHub repository secrets for Actions).
- **Don't switch CI to `pull_request_target`** unless you fully understand the
  implications — it runs in the base repo's context with secrets available,
  and is the most common way OSS projects leak credentials.
