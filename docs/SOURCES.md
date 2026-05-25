# Sources & enrichment — the post-2024 Spotify reality

Crate Digger pulls candidate tracks from **ingestion adapters** and fills in
audio features + genres from **enrichment providers**. This file records why
the architecture looks the way it does — so future-Hans / future-Claude
doesn't re-discover it the hard way.

## TL;DR

- **Spotify** = ingestion (search) + metadata (ISRC, duration, year) + genres
  (via artist lookup). It no longer supplies audio features.
- **ReccoBeats** = audio features (tempo, energy, valence, danceability,
  acousticness, instrumentalness). Free, no API key.
- **Last.fm** = ingestion (search / similar / chart) + tags.
- **Viberate** = optional paid trend source.

## Spotify Web API cliffs

### 2024-11-27 — endpoints retired for new apps

Spotify retired a set of endpoints for any app **registered after
2024-11-27**. Apps created before that date keep working; new apps get `403`.
Retired: `/audio-features`, `/audio-analysis`, `/recommendations`, Related
Artists.

Consequence for Crate Digger: the 6 audio dimensions of the 64-dim embedding
can no longer come from Spotify. A new app degrades _silently_ — ingestion
runs, but `track.audio_features` stays null and bucketing collapses to
genre-only. **ReccoBeats replaces `/audio-features`** (see below).

### 2026-02-06 — Dev Mode tightened

- Every Dev Mode app now requires the **owner to hold Spotify Premium**.
  No localhost / single-user exemption.
- **Redirect URIs must use the IPv4 loopback `127.0.0.1`**, not `localhost`.
  Crate Digger's default `SPOTIFY_REDIRECT_URI` is
  `http://127.0.0.1:3000/api/auth/spotify/callback`; whatever you put in
  `.env` must match the URI registered in the Spotify Developer Dashboard
  exactly.
- **Batch endpoints removed**: `/tracks?ids=`, `/albums?ids=`,
  `/artists?ids=`. All lookups must be individual `GET /…/{id}`.
- **`/search` `limit` capped at 10** (was 50).
- `/artists/{id}/top-tracks`, `/browse/*`, `/markets` removed.
- ISRC was briefly dropped, then **restored in the March 2026 changelog** —
  `external_ids` is back on Track and Album.

## What Crate Digger depends on from Spotify

Only endpoints that survive Feb 2026 Dev Mode:

| Endpoint                     | Used by               | Notes                                               |
| ---------------------------- | --------------------- | --------------------------------------------------- |
| `POST /api/token`            | all calls             | Client Credentials                                  |
| `GET /search?type=track`     | `spotify.ts` adapter  | paged at `limit=10`, offset-paginated up to 5 pages |
| `GET /artists/{id}`          | `spotify-metadata.ts` | individual lookup — batch `?ids=` is gone           |
| `GET /playlists/{id}/tracks` | `cold-start.ts`       | playlist endpoints unaffected by the cliffs         |

The Spotify adapter does **not** touch any batch `?ids=` endpoint,
`/recommendations`, `/audio-features`, `/artists/{id}/top-tracks`,
`/browse/*`, or `/markets`. Keep it that way — they 403 on new apps.

## ReccoBeats — the audio-features replacement

`GET https://api.reccobeats.com/v1/audio-features?ids=<spotify ids>` returns
Spotify-shaped audio features keyed by Spotify track id. Free, no auth.

Caveats baked into `src/lib/enrichment/reccobeats.ts`:

- **Bus factor 1.** Run by a single operator; no documented business model.
  Treat it as the working choice with a fallback in mind (tracked as LAB-5).
- **Undocumented rate limits.** We pace at ~2 req/s, batch ≤5 ids per
  request, and honour `Retry-After` on 429 (`src/lib/enrichment/rate-limit.ts`).
- **Uncharacterised coverage.** Long-tail / non-Western / indie tracks may
  return nothing. "No features" is a normal outcome, not an error — the track
  still ingests and buckets on genres alone. The
  `audio_feature_coverage` KPI (Console screen) makes coverage rot visible.
- **Caching.** Once a track has `audio_features`, it is never refetched —
  the `audio_features IS NULL` filter on the enrich query _is_ the cache.
- **Bonus fields.** ReccoBeats also returns `key`, `mode`, `isrc`. `key`/`mode`
  are ignored (using them is a 64-dim-embedding change — out of scope);
  `isrc` is opportunistically backfilled into `track.isrc` when null.

The response envelope is parsed defensively (`parseFeatureEntries`) — confirm
it against the live API if coverage numbers look wrong.

## Not pursued

- **Self-hosting Essentia / Meyda** for local audio extraction — out of scope.
- **Spotify Extended Quota** — needs a legal entity + 250K MAU. Unattainable.
