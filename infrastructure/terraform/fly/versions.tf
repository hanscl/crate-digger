terraform {
  required_version = ">= 1.7.0"

  required_providers {
    fly = {
      source = "fly-apps/fly"
      # The fly-apps/fly provider only publishes 0.0.x releases (latest 0.0.23
      # at the time of writing). `~> 0.1` would resolve to no matching version.
      version = ">= 0.0.19, < 0.1.0"
    }
  }
}

provider "fly" {
  # Reads the FLY_API_TOKEN environment variable. Generate with
  # `flyctl tokens create deploy -a <app-name>` (preferred — app-scoped) or
  # `flyctl auth token` (org-scoped) and export before running terraform.
}
