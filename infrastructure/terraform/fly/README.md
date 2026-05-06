# Fly.io terraform module

Tier 3 cloud deploy — provisions the Fly app shell + secrets. `flyctl deploy`
(via `.github/workflows/deploy.yml` or run locally) handles the actual machine
rollouts using the repo-root `fly.toml`.

This split is deliberate. Terraform owns rarely-changing infrastructure (app,
IPs, secrets); flyctl owns the per-deploy machine lifecycle. Keeping machines
out of terraform avoids state churn on every release.

Postgres is **out of scope** — Constraint #10 says `DATABASE_URL` is the
single env-var swap point. See "Database options" below.

## Prerequisites

- Terraform >= 1.7
- A Fly.io account + `flyctl auth login`
- `FLY_API_TOKEN` exported. Prefer an app-scoped deploy token
  (`flyctl tokens create deploy -a <app-name>`) so a leak only affects one
  app; `flyctl auth token` works too but is org-scoped.

## Usage

```sh
cd infrastructure/terraform/fly
cp terraform.tfvars.example terraform.tfvars   # fill in non-sensitive values
export FLY_API_TOKEN=$(flyctl tokens create deploy -a crate-digger)
export TF_VAR_database_url='postgres://...?sslmode=require'
export TF_VAR_admin_passphrase=$(openssl rand -hex 32)
export TF_VAR_anthropic_api_key=...   # optional
terraform init
terraform plan
terraform apply
git add .terraform.lock.hcl && git commit -m "terraform: pin fly provider"
```

Apply creates the Fly app, allocates IPv6 + shared IPv4, and pushes secrets.
The app exists but has no machines yet — first deploy comes from flyctl:

```sh
cd ../../..   # back to repo root
flyctl deploy --remote-only --app crate-digger
```

After the first deploy, GitHub Actions (`deploy.yml`) takes over for
subsequent releases.

## Two-environment setup (staging + prod)

The recommended layout is two separate Fly apps managed by two terraform
workspaces (or two state files):

```sh
# Staging
terraform workspace new staging
TF_VAR_database_url=$STAGING_DB_URL \
TF_VAR_admin_passphrase=$STAGING_PASS \
terraform apply -var app_name=crate-digger-staging -var cron_disabled=true

# Production
terraform workspace new prod
TF_VAR_database_url=$PROD_DB_URL \
TF_VAR_admin_passphrase=$PROD_PASS \
terraform apply -var app_name=crate-digger
```

Setting `cron_disabled=true` on staging keeps the daily pipeline from running
twice (once on staging, once on prod) against shared upstream APIs.

## Database options

Pick one and set `database_url` accordingly. The app needs Postgres 14+ with
the `pgvector` extension installed.

### Fly Postgres (managed by Fly)

```sh
flyctl postgres create --name crate-digger-pg --region fra
flyctl postgres connect --app crate-digger-pg
# in psql:
CREATE EXTENSION vector;
\q
flyctl postgres attach --app crate-digger crate-digger-pg
# This sets DATABASE_URL on the app via flyctl. If you'd rather have terraform
# own the secret, copy the printed connection string into TF_VAR_database_url
# and `flyctl secrets unset DATABASE_URL --app crate-digger` afterwards so
# terraform is the source of truth.
```

### Neon (https://neon.tech)

Create a project; pgvector is preinstalled. Connection string format:

```
postgres://USER:PASSWORD@ep-xxx.region.aws.neon.tech/DBNAME?sslmode=require
```

### Supabase (https://supabase.com)

Project Settings → Database → Connection string → URI. Enable pgvector under
Database → Extensions. Use the _connection pooler_ URL on Fly to avoid running
out of direct connections during cron-driven traffic spikes:

```
postgres://USER.PROJECT:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true
```

### AWS RDS

Provision a Postgres 16 instance, install pgvector via the parameter group,
and ensure the security group allows traffic from Fly's egress IPs (or use a
VPN / private link). Connection string:

```
postgres://USER:PASSWORD@your-instance.region.rds.amazonaws.com:5432/DBNAME?sslmode=require
```

### Self-hosted Postgres

Anywhere you can run `pgvector/pgvector:pg17`. Same connection-string format
as above; ensure pgvector is installed.

## Outputs

- `app_url` — public URL once flyctl has rolled out a release.
- `app_hostname` — bare hostname (used to derive the Spotify redirect URI when
  `spotify_redirect_uri` is left blank).

## Notes

- The `fly-apps/fly` provider is community-maintained. If it stops working for
  you, the entire module's responsibility (app + IPs + secrets) can be
  replicated with a handful of `flyctl` commands; see PROGRESS notes for the
  exact equivalents.
- Secrets are never echoed in plan/apply output (all `sensitive = true`).
- Terraform state contains secret values — store remote state somewhere
  encrypted at rest (S3 + KMS, Terraform Cloud, etc.) before sharing.
