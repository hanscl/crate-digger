# Sources & enrichment — the post-2024 Spotify reality

Crate Digger pulls candidate tracks from **ingestion adapters** and fills in
audio features + genres from **enrichment providers**. This file records why
the architecture looks the way it does — so future-Hans / future-Claude
doesn't re-discover it the hard way.

## TL;DR

- **Spotify** = ingestion (search) + metadata (ISRC, duration, year). It no
  longer supplies audio features _or_ genres on new Dev Mode apps.
- **ReccoBeats** = audio features (tempo, energy, valence, danceability,
  acousticness, instrumentalness). Free, no API key.
- **Last.fm** = ingestion (search / similar / chart) **+ genre signal via
  `track.getTopTags`** (replaces Spotify artist genres, see below).
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

### Mid 2026 — `artist.genres` returns null

Discovered May 2026 during LAB-1 runbook verification: every
`GET /v1/artists/{id}` response on a post-2024-11-27 Dev Mode app returns
`"genres": null` rather than a populated array. Confirmed against multiple
artists (The Shins, Band of Horses, etc.) under valid Client Credentials.
The field is still present in the response — Spotify has dropped genre
data for new app credentials rather than removed the endpoint.

Consequence for Crate Digger: the 58-slot genre half of the embedding
went dark, `primary_genre` was null on every Spotify-sourced track, and
bucketing collapsed to audio-only clustering. **Last.fm tags
(`track.getTopTags`) replace the Spotify path** — see "Genres via
Last.fm tags" below. Tracked as LAB-22.

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

Only endpoints that survive Feb 2026 Dev Mode and still return signal:

| Endpoint                     | Used by              | Notes                                                                                                                                  |
| ---------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/token`            | all calls            | Client Credentials                                                                                                                     |
| `GET /search?type=track`     | `spotify.ts` adapter | paged at `limit=10`, offset-paginated up to 5 pages                                                                                    |
| `GET /tracks/{id}`           | `cold-start.ts`      | individual track lookup — batch `?ids=` is gone                                                                                        |
| `GET /playlists/{id}/tracks` | `cold-start.ts`      | **editorial playlists only** under Client Credentials (see below). User-generated playlists need user OAuth — workaround in LAB-20/21. |

The Spotify adapter does **not** touch any batch `?ids=` endpoint,
`/recommendations`, `/audio-features`, `/artists/{id}` (the response no
longer carries `genres` — see above), `/artists/{id}/top-tracks`,
`/browse/*`, or `/markets`. Keep it that way — they 403 or return empty
fields on new apps.

### User-generated playlists return 403

Discovered May 2026 during LAB-1 verification: `GET /playlists/{id}/tracks`
returns **403** on new Dev Mode apps when the playlist is user-generated, even
when set to public. Only Spotify-owned editorial playlists (Today's Top Hits,
RapCaviar, anything in "Made by Spotify") are reachable via Client Credentials.

- **Immediate workaround (LAB-20):** Setup screen has a "paste track URLs"
  card. Export track URLs from a Spotify playlist via the desktop app
  (open playlist → ⌘A → right-click → Share → Copy Spotify URIs) and paste
  them in. Each URL hits `GET /tracks/{id}` (still works) and feeds the same
  cold-start pipeline.
- **Proper fix (LAB-21):** Spotify user OAuth (Authorization Code + PKCE).
  Grants `playlist-read-private` + `user-library-read` so the playlist URL
  card and a future Liked Songs button work against the user's own library.

## Genres via Last.fm tags

`GET https://ws.audioscrobbler.com/2.0/?method=track.getTopTags&artist=…&track=…`
returns a popularity-weighted tag cloud for any track Last.fm has heard of.
This is Crate Digger's genre signal as of LAB-22 — Spotify
`artist.genres` is dead (see above) and Last.fm tags happen to map cleanly
onto the existing 58-slot genre taxonomy in `src/lib/embedding.ts`
(no taxonomy rewrite required — raw tag strings flow through unchanged).

Implementation lives in `src/lib/enrichment/lastfm-tags.ts`:

- **Per-track lookup** keyed on `(artist, title)`. `autocorrect=1` lets
  Last.fm fix minor spelling. `mbid` isn't persisted yet — could be added
  if (artist, title) match rate ever proves insufficient.
- **Count threshold**: tags with `count < 10` get dropped. Last.fm tag
  counts saturate at 100 for the top tag; single-user fan tags
  ("favourite", "seen live") usually sit at 1-5.
- **Top-N cap**: at most 8 tags per track. The keyword matcher in
  `embedding.ts` saturates well below that — more is noise.
- **Graceful degradation**: in-body error envelope (`error: 6 "track not
found"`), HTTP non-200, and empty responses all collapse to "no tags"
  rather than throw. A track without tags still ingests and buckets on
  audio alone.
- **Idempotency**: only targets tracks with empty `genres` — the
  `cardinality(genres) = 0` filter _is_ the cache.

Coverage caveat: long-tail / non-Western / very-new tracks may return no
tags. Last.fm's catalogue is biased toward Western indie/rock/electronic
— if `genre_coverage` looks anaemic for a non-Western corpus, lean on
the audio half of the embedding (ReccoBeats has broader coverage).

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
