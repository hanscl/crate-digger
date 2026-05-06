# Crate Digger — Fly.io app shell.
#
# This module provisions the Fly app, IPs, and secrets. It does NOT create
# Fly machines — `flyctl deploy` (driven by .github/workflows/deploy.yml or
# run locally) handles image builds and machine rollouts. Splitting these
# concerns matches the Fly recommended pattern: terraform owns rarely-changing
# infrastructure (the app shell, secrets, IPs); flyctl owns the per-deploy
# machine lifecycle.
#
# Postgres is intentionally out-of-scope — Constraint #10 says DATABASE_URL
# is the single env-var swap. See README.md for the three documented paths
# (Fly Postgres via flyctl, managed external DB, self-hosted Postgres).

locals {
  spotify_redirect_uri = (
    var.spotify_redirect_uri != ""
    ? var.spotify_redirect_uri
    : "https://${var.app_name}.fly.dev/api/auth/spotify/callback"
  )

  # All app secrets keyed by Fly secret name. Empty values are filtered out
  # below so we never push an empty Spotify/Last.fm/Viberate secret that
  # would mask `optional().default("")` in src/server/env.ts.
  raw_secrets = {
    DATABASE_URL          = var.database_url
    ADMIN_PASSPHRASE      = var.admin_passphrase
    ANTHROPIC_API_KEY     = var.anthropic_api_key
    SPOTIFY_CLIENT_ID     = var.spotify_client_id
    SPOTIFY_CLIENT_SECRET = var.spotify_client_secret
    SPOTIFY_REDIRECT_URI  = local.spotify_redirect_uri
    LASTFM_API_KEY        = var.lastfm_api_key
    VIBERATE_API_KEY      = var.viberate_api_key
    CRON_DISABLED         = var.cron_disabled ? "1" : ""
  }

  secrets = { for k, v in local.raw_secrets : k => v if v != "" }
}

resource "fly_app" "this" {
  name = var.app_name
  org  = var.fly_org
}

# Dedicated IPv6 is free and required for Fly's HTTPS routing.
resource "fly_ip" "v6" {
  app  = fly_app.this.name
  type = "v6"
}

# Shared v4 is free; toggle off and run `flyctl ips allocate-v4 --shared=false`
# if you need a dedicated (billable) v4.
resource "fly_ip" "v4_shared" {
  count = var.assign_shared_ipv4 ? 1 : 0
  app   = fly_app.this.name
  type  = "v4"
}

resource "fly_app_secret" "secrets" {
  for_each = local.secrets

  app   = fly_app.this.name
  name  = each.key
  value = each.value
}
