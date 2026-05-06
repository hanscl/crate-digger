terraform {
  required_version = ">= 1.7.0"

  required_providers {
    fly = {
      source  = "fly-apps/fly"
      version = "~> 0.1"
    }
  }
}

provider "fly" {
  # Reads the FLY_API_TOKEN environment variable. Generate with
  # `flyctl auth token` and export before running terraform.
  useinternaltunnel = false
}
