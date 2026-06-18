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
  `artist.getTopTags`** (replaces Spotify artist genres, see below).
- **Viberate** = optional paid discovery engine — a multi-feed _breakout_ pool
  (YouTube + Shazam/SoundCloud composite + Spotify), scored to lead the
  mainstream (see "Viberate — social-breakout discovery engine"
  below).

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
bucketing collapsed to audio-only clustering. **Last.fm
`artist.getTopTags` replaces the Spotify path** — see "Genres via
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

`GET https://ws.audioscrobbler.com/2.0/?method=artist.getTopTags&artist=…`
returns a popularity-weighted tag cloud for any artist Last.fm has heard
of. This is Crate Digger's genre signal as of LAB-22 — Spotify
`artist.genres` is dead (see above) and Last.fm tags happen to map cleanly
onto the existing 58-slot genre taxonomy in `src/lib/embedding.ts`
(no taxonomy rewrite required — raw tag strings flow through unchanged).

### Why artist-level, not track-level

We started on `track.getTopTags` (per-track tag cloud), but as of
mid-2026 it returns empty across the board — Beach House / Levitation,
The Shins / Simple Song, all confirmed empty under valid credentials.
`track.getInfo`'s embedded `toptags` is empty too. Last.fm appears to
have killed track-level user tags without announcement, while keeping
artist-level intact.

The semantic tradeoff is acceptable for our case: every track by an
artist gets the same genre vector, which actually matches the bucketing
intent (same-artist clustering pulls a discography together). One-off
cross-genre side projects lose track-specific tagging — accepted.

### Implementation

Lives in `src/lib/enrichment/lastfm-tags.ts`:

- **Per-artist lookup** with `autocorrect=1`. Within an enrichment run
  the per-artist cache collapses N tracks-by-one-artist to a single
  Last.fm call.
- **Primary-artist split**: Spotify joins multi-artist credits as
  `"Artist A, Artist B"` in `track.artist`. Last.fm autocorrect can't
  resolve through that, so we split on `", "` and pass only the head.
  False splits on band names containing commas ("Crosby, Stills & Nash")
  are rare; autocorrect often still resolves the fragment.
- **Count threshold**: tags with `count < 10` get dropped. Last.fm tag
  counts saturate at 100 for the top tag; single-user fan tags
  ("favourite", "seen live") usually sit at 1-5.
- **Top-N cap**: at most 8 tags per artist. The keyword matcher in
  `embedding.ts` saturates well below that — more is noise.
- **Graceful degradation**: in-body error envelope (`error: 6 "artist
not found"`), HTTP non-200, and empty responses all collapse to "no
  tags" rather than throw. A track without tags still ingests and
  buckets on audio alone.
- **Idempotency**: skip when `'lastfm' = ANY(track.genre_sources_processed)`.
  Append `'lastfm'` on every completed pass — success, empty result,
  "Various Artists" skip, or in-body error — so we never retry. The
  guard works alongside the MusicBrainz and Discogs layers, each of
  which tracks its own source id.
- **Various Artists skip**: artist == "Various Artists" → no API call,
  still flagged processed (artist axis is degenerate; MB and Discogs
  carry the signal for compilations).
- **Additive merge**: tags returned merge into `track.genres` rather
  than overwrite — preserves contributions from any earlier source. The
  embedding is rebuilt from the merged array.

Coverage caveat: long-tail / non-Western / very-new artists may return
no tags. Last.fm's catalogue is biased toward Western
indie/rock/electronic — if `genre_coverage` looks anaemic for a
non-Western corpus, lean on the audio half of the embedding (ReccoBeats
has broader coverage), and on the MusicBrainz + Discogs layers below.

## Supplementary genres via MusicBrainz

`GET https://musicbrainz.org/ws/2/recording/{mbid}?inc=genres+tags&fmt=json`
returns curated genres + raw folksonomy tags for a recording. MB stores
recording-level tags for many tracks thanks to the 2021 backfill that
propagated Last.fm + Discogs + beatunes tags down to recording entities.
This layer recovers per-track signal that Last.fm artist-only collapses
(side projects, "Various Artists" compilations).

Lives in `src/lib/enrichment/musicbrainz.ts`:

- **MBID resolution chain** per track:
  1. `track.mbid` already set → use it.
  2. Else call Last.fm `track.getInfo` for that (artist, title). If the
     response carries `track.mbid`, persist it on the row and use it.
  3. Else mark processed and skip.
- **Recording lookup** with `inc=genres+tags`. Curated `genres[].name`
  and raw `tags[].name` both feed `mergeGenres` — the 58-slot keyword
  matcher in `embedding.ts` filters out non-genre tags harmlessly.
- **Rate limit**: 1 req/s per MB's API usage policy, enforced by a
  module-level `createRateLimiter(1000)`. Uses `fetchWithRetry` for
  Retry-After handling.
- **User-Agent**: `CrateDigger/0.1 (mailto:<MUSICBRAINZ_CONTACT_EMAIL>)`.
  MB rejects requests with anonymous User-Agents; the contact email is
  the required identifier. Set `MUSICBRAINZ_CONTACT_EMAIL` in `.env` —
  empty → enricher is skipped (graceful degradation to Last.fm only).
- **Idempotency**: per-source guard via `genre_sources_processed`
  (same model as Last.fm).
- **Licensing**: MB tag/genre data is CC BY-NC-SA. Fine for a personal
  self-hosted Crate Digger; if you ever distribute commercially, get a
  MetaBrainz commercial licence.

## Supplementary genres + sub-genres via Discogs

`GET https://api.discogs.com/database/search?type=master&...` + a follow-up
GET on `/masters/{id}` (fallback `/releases/{id}`) returns coarse
`genres[]` (e.g. "Electronic", "Rock") and the useful `styles[]`
sub-genre layer (e.g. "Synth-pop", "Indietronica", "Indie Rock").
Discogs covers indie / electronic / dance catalogues particularly well
where Last.fm + MB are thin.

Lives in `src/lib/enrichment/discogs.ts`:

- **Master-first lookup**: search `type=master&q=<artist> <title>`,
  fetch `/masters/{id}` if hit (canonical, edition-independent styles).
  Falls back to `type=release` + `/releases/{id}` if no master matches.
  Both miss → mark processed and skip.
- **Rate limit**: 50 req/min (1200ms interval) — safely below Discogs'
  60/min authenticated ceiling. Real throughput ≈ 16–25 tracks/min
  given 2–3 calls per track.
- **Auth**: consumer key/secret as URL params (Discogs supports both
  param and header forms; URL param avoids per-request header
  construction). User-Agent identifies the app.
- **Optional**: set both `DISCOGS_KEY` and `DISCOGS_SECRET` in `.env`;
  either empty → enricher is skipped. Free credentials at
  https://www.discogs.com/settings/developers.
- **Idempotency**: per-source guard via `genre_sources_processed`.

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

## Viberate — social-breakout discovery engine (paid, optional)

Viberate (https://www.viberate.com/music-data-api/) is a paid music-analytics
platform: 11M+ artists, 100M+ tracks, daily-refreshed from Spotify, YouTube,
TikTok, Shazam, airplay, etc. Crate Digger uses it as a **breakout discovery
engine** (LAB-90) — the goal is to get OUT of the popular-playlist tail and
surface tracks breaking out on social/alternative signals _before_ they're
mainstream. Lives in `src/lib/ingestion/viberate/`; spike artifacts
`scripts/lab87-viberate-probe.ts` (LAB-87) + `scripts/lab-viberate-engine-probe.ts`
(LAB-90).

### Why not just "trending"

The top of _every_ Viberate chart is mainstream — sort the composite chart by
"Viberate score" and you get Taylor Swift / Bad Bunny. Pulling "trending" off
any single ranking lands right back in the short tail. The breakout signal is
**divergence**: high social/alternative momentum (Shazam, SoundCloud, YouTube)
while Spotify presence (streams, playlist reach) is still LOW. LAB-88's original
Spotify-trending feed (sorted by 1-day stream % gain) is Spotify-native — kept,
but down-weighted to one contributor.

### Spike findings (verified live)

- **Base URL** `https://data.viberate.com/api/v1`; **auth** a single static
  header `Access-Key: <VIBERATE_API_KEY>` (no token exchange). Rate limit
  ~**60/window** (`GET /rate-limit/status`, free); the engine paces through a
  module-scoped limiter (~54/min) and honours `Retry-After`.
- **YouTube trending** `GET /track/trending/youtube/country?sort=views_1w_pct`:
  rows carry view momentum but no ISRC/uuid (`track_id` is a `G:…` namespace,
  unusable). Resolve via `GET /track/by-channel/youtube/{youtube_id}` →
  `{uuid, isrc, genre, subgenres}` in one call.
- **Composite chart** `GET /track/viberate/chart?sort=shazam-shazams|soundcloud-plays&timeframe=1w`:
  rows carry `uuid` + `genre` + **inline `charts.{shazam,spotify,viberate}`**
  timeseries — so the breakout gap (social vs Spotify) is computable from the
  chart call itself. Surfaces genuinely obscure artists. ISRC via
  `GET /track/{uuid}/details`.
- **Resolution/maturity** `GET /track/{uuid}/details` → ISRC; `…/links` →
  explicit Spotify id; `…/viberate/stats-alltime` → compact cross-platform
  snapshot (the Spotify-maturity input for YouTube candidates).

### What the engine ships (3 stages, `src/lib/ingestion/viberate/`)

1. **Broad pool** (`pool.ts`) — pull YouTube-trending (DE/GB/US) + composite
   chart (Shazam + SoundCloud) + Spotify-trending (`VIBERATE_TRENDING_COUNTRY`),
   map each to a common `PooledRow`, dedup the union.
2. **Score + select** (`breakout.ts`) — `score = clamp01(socialMomentum −
0.6·spotifyMaturity)` (heavy-tailed counts log-saturated), then keep the top
   `limit` weighted by feed (composite 1.0 · youtube 0.9 · spotify 0.45). This
   is pull **composition within the LAB-51 pull-size throttle** — NOT a surfacing
   filter; everything returned is still ingested in full (Constraint #5).
3. **Resolve** (`resolve.ts`) — resolve only the shortlist to an ISRC (+ Spotify
   maturity for YouTube rows), recompute the final breakout, emit `RawCandidate`s.
   `resolve.ts`/ReccoBeats/genre enrichers do the rest downstream.

The breakout signal (`{score, socialMomentum, spotifyMaturity, signals}`) rides
on `track_source.raw_payload` — a **discovery signal only**, never the taste
model. **Constraint #1:** absent `VIBERATE_API_KEY` the engine is unavailable
(guard before any network call); trending-only (`similar`/`search` → `[]`);
never throws (`[]` on any error).

### Deferred / out of scope (v1)

- **TikTok velocity** — per-track TikTok metrics live only under
  `/requested-track/{uuid}/tiktok/*`, which requires _registering_ the track
  (metered, consumes plan quota). The registration flow was deliberately not
  exercised in the spike, so TikTok is not wired in v1; enabling it (and any
  budget cap) is tracked in LAB-91, pending a live verification pass.
- **Ranker integration (PR-2)** — wiring the stored breakout score into the
  broad ranker as a soft down-weight (project `Candidate.source`/breakout, bump
  broad `model_version`, params knob) is a separate focused PR; it touches the
  versioned ranker + counterfactual replay.
- Artist-level `social-rank` chart, `track/search`, deep historical analytics —
  available, not wired for a personal taste model.

## ChartMetric — social-breakout discovery engine (paid, optional)

ChartMetric (https://chartmetric.com) is a paid music-analytics platform with
per-platform charts (Spotify, Apple Music, Shazam, TikTok, SoundCloud, …) and a
rich per-track cross-platform stats snapshot. Crate Digger uses it as a second
**breakout discovery engine** (LAB-117) — the ChartMetric-powered sibling of the
Viberate engine — so the two run head-to-head and QA + ratings (per-source
keep-rate) decide which surfaces better. Lives in `src/lib/ingestion/chartmetric/`;
spike artifact `scripts/lab-chartmetric-engine-probe.ts`. Same objective and shape
as Viberate: pull a pool that LEADS Spotify, score the divergence, surface before
mainstream.

### Billing

ChartMetric has two models. The **public** API tier is a flat **~$350/mo**
subscription (rate-limit tiers). A personal account, though, can run on a
**prepaid usage-based** plan (~**$0.01/credit** ≈ 1 credit per API call) — a daily
breakout run is ~4–16 calls (a few cents), which is what makes it viable for a
single-user install. (Viberate, by contrast, is a flat ~$250/mo subscription.)
Stay on the prepaid plan for personal use.

### Spike findings (verified live, 2026-06-17)

- **Base URL** `https://api.chartmetric.com`; **auth** a refresh-token exchange:
  `POST /api/token {refreshtoken}` → a ~1h bearer (`Authorization: Bearer`); 429s
  carry `X-RateLimit-*` headers. The refresh token is long-lived.
- **Every chart row carries ISRC + `cm_track` + `spotify_popularity` (0–100) +
  `rank`/`pre_rank`/`velocity` INLINE** — dedup needs no resolution hop (an
  improvement over Viberate), and a coarse maturity proxy is free on every row.
- **Charts** (verified params; they reject `limit`/`offset`, so we slice):
  `/api/charts/shazam?country_code&date` (`num_of_shazams`),
  `/api/charts/tiktok/tracks?interval=weekly&date` (`weekly_posts`),
  `/api/charts/soundcloud?country_code&kind=trending&genre&interval&date`,
  `/api/charts/spotify?type=regional&country_code&interval=daily&date`
  (`current_plays` — the maturity feed). Charts require a `date` and lag a few
  days, so the client walks a small date ladder and takes the first non-empty.
- **Continuous maturity** `GET /api/track/{cm_track}` → `cm_statistics`
  (`sp_playlist_total_reach`, `sp_streams`, `sp_popularity`, `shazam_counts`,
  `num_tt_videos`) + `genres` — one call gives the full cross-platform gap (a
  richer analog of Viberate's `stats-alltime`).
- **ISRC → ids** `GET /api/track/isrc/{isrc}/get-ids` → `chartmetric_ids` +
  `spotify_ids` (not needed in v1 — ISRC + the Spotify id are inline).

### What the engine ships (3 stages, `src/lib/ingestion/chartmetric/`)

1. **Broad pool** (`pool.ts`) — pull Shazam + SoundCloud + TikTok (social) +
   Spotify-regional (maturity, `CHARTMETRIC_TRENDING_COUNTRY`) charts; map each to
   a common `PooledRow` (ISRC/cm_track/signals inline); dedup the union, folding
   signals so a track seen on a social AND the Spotify chart gets the full gap
   with no resolve hop.
2. **Score + select** (`breakout.ts`) — the SAME model as Viberate, so the A/B is
   apples-to-apples: `score = clamp01(socialMomentum − 0.6·spotifyMaturity)`,
   social from Shazam/TikTok/SoundCloud counts + chart velocity, maturity from
   `spotify_popularity` + streams + playlist reach. Keep the top `limit` weighted
   by feed (social 1.0 · tiktok 0.9 · spotify 0.45). Pull composition, not a
   surfacing filter (Constraint #5).
3. **Resolve** (`resolve.ts`) — for shortlisted social rows lacking continuous
   maturity, one `GET /api/track/{cm_track}` upgrades `spotify_popularity` to
   `sp_playlist_total_reach`/`sp_streams` + folds genres; recompute, emit.

The breakout signal rides on `track_source.raw_payload` (discovery signal only,
never the taste model). **Constraint #1:** absent `CHARTMETRIC_REFRESH_TOKEN` the
engine is unavailable (guard before any network call); trending-only; never throws.

### A/B with Viberate

Both engines are key-gated and run in the same daily pipeline when configured, so
with both keys set they pull every day and `surface_event.candidate_pool` logs the
full context (Constraint #2). Attribution rides on `track_source.source` (per-source
provenance); `evals/metrics.ts → keepRate().bySource` already reports per-source
keep/dislike rate — `viberate` vs `chartmetric` head-to-head, no extra plumbing.
The LAB-19 ChartMetric _TikTok-velocity provider_ was retired here (it called the
wrong endpoint — `/charts/tiktok` 404s, the real path is `/charts/tiktok/tracks` —
and was never live-verified); this engine subsumes the TikTok chart as one feed.

## Not pursued

- **Self-hosting Essentia / Meyda** for local audio extraction — out of scope.
- **Spotify Extended Quota** — needs a legal entity + 250K MAU. Unattainable.
