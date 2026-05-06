variable "app_name" {
  type        = string
  description = "Fly.io app name. Must be globally unique. Convention: 'crate-digger' for prod, 'crate-digger-staging' for staging."
}

variable "fly_org" {
  type        = string
  default     = "personal"
  description = "Fly.io organization slug. 'personal' for solo accounts; otherwise your team slug."
}

variable "primary_region" {
  type        = string
  default     = "fra"
  description = "Primary Fly region. See https://fly.io/docs/reference/regions/."
}

variable "assign_shared_ipv4" {
  type        = bool
  default     = true
  description = "Allocate a shared IPv4. Set to false if you want to provision a dedicated v4 (billable) — do that manually with `flyctl ips allocate-v4 --shared=false`."
}

# ---------------------------------------------------------------------------
# Secrets — passed through to Fly app secrets. All marked sensitive so they
# never appear in plan/apply output. Source them from your own vault.
# ---------------------------------------------------------------------------

variable "database_url" {
  type        = string
  sensitive   = true
  description = "Postgres connection string. Constraint #10: this is the single env-var swap point — point it at Fly Postgres, Neon, Supabase, RDS, or anything else that speaks Postgres + pgvector."
}

variable "admin_passphrase" {
  type        = string
  sensitive   = true
  description = "Single-user dashboard passphrase. Generate with `openssl rand -hex 32`."
}

variable "anthropic_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional. Powers bucket auto-naming, why-surfaced explanations, and cold-start playlist parsing. App boots without it; agents fall back to deterministic placeholders."
}

variable "spotify_client_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional. Spotify app client ID."
}

variable "spotify_client_secret" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional. Spotify app client secret."
}

variable "spotify_redirect_uri" {
  type        = string
  default     = ""
  description = "Optional. Spotify OAuth redirect URI. Defaults to https://<app_name>.fly.dev/api/auth/spotify/callback when empty."
}

variable "lastfm_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional. Last.fm API key. Adapter is skipped when empty."
}

variable "viberate_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional. Viberate (paid) API key. System runs fully on Spotify + Last.fm without it."
}

variable "cron_disabled" {
  type        = bool
  default     = false
  description = "Set true to disable the in-process node-cron schedule (manual triggers still work). Useful for staging to keep the runner quiet."
}
