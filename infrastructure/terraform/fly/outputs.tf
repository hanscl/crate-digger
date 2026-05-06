output "app_name" {
  value       = fly_app.this.name
  description = "Provisioned Fly app name."
}

output "app_hostname" {
  value       = "${fly_app.this.name}.fly.dev"
  description = "Default Fly hostname. The Spotify OAuth redirect URI is derived from this unless overridden."
}

output "app_url" {
  value       = "https://${fly_app.this.name}.fly.dev"
  description = "Public app URL once a release has been deployed via flyctl."
}

output "primary_region" {
  value       = var.primary_region
  description = "Primary region (informational — Fly machines pick up the value from fly.toml during deploy)."
}
