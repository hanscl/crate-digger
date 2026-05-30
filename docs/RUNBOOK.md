# Build & Test Runbook

End-to-end verification walk for Crate Digger. Pick this up on a fresh
checkout to confirm every constraint from `PLAN.md` is wired through —
prereqs, boot, the full data flow, and the taste-profile round-trip.

Originally lived in LAB-1's Linear description. Refreshed after LAB-4
(ReccoBeats audio features), LAB-20 (paste-track-URLs cold-start), and
the LAB-22 → LAB-23 genre-sourcing rework. See `docs/SOURCES.md` for the
underlying Spotify reality this walk works around.

> **Why genres come from where they do.** The original walk hit a wall at
> step 3.2 when Spotify `/v1/artists/{id}` started returning
> `"genres": null` on new Dev Mode apps — bucketing collapsed to
> audio-only clustering (107 varied tracks → only 2 buckets). Resolved in
> LAB-22 (Last.fm `artist.getTopTags`, with per-artist caching and a
> multi-artist-credit split) and extended in LAB-23 (MusicBrainz +
> Discogs layers). Genre tagging now runs on three independent,
> individually-optional sources — **step 3.4 verifies the layering and
> its graceful degradation.** See `docs/SOURCES.md`.

## 1. Prereqs

### Docker

Required for the local Postgres+pgvector container and the
testcontainers suites.

```sh
docker info     # daemon up?
```

If Docker Desktop is installed but `docker` is not on PATH, add its
`bin/` to your shell rc (Docker Desktop ships an unlinked CLI).

### `.env`

```sh
cp .env.example .env
```

Required keys:

- `ADMIN_PASSPHRASE` — server refuses to boot if unset.
  `openssl rand -hex 32`.
- `DATABASE_URL` — keep the example default for local compose.

Optional but needed for a meaningful end-to-end walk:

- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — Spotify ingest +
  metadata only (genres come from Last.fm/MusicBrainz/Discogs, not
  Spotify). **Owner of the Dev Mode app must hold Spotify Premium** as
  of 2026-02-06 (`docs/SOURCES.md`). No localhost exemption.
- `SPOTIFY_REDIRECT_URI` — defaults to
  `http://127.0.0.1:3000/api/auth/spotify/callback`. Must match the
  Redirect URI registered in the Spotify Developer Dashboard **exactly**,
  and must use `127.0.0.1` — Spotify no longer accepts `localhost`.
- `ANTHROPIC_API_KEY` — bucket auto-naming, why-surfaced copy, playlist
  parser. Without it, agents fall back to deterministic placeholders;
  the app still works.
- `LASTFM_API_KEY` — Last.fm ingest **and** the baseline genre signal
  (`artist.getTopTags`). Free key at `last.fm/api/account/create`. Also
  used by the MusicBrainz layer to resolve recording MBIDs.
- `MUSICBRAINZ_CONTACT_EMAIL` — enables the MusicBrainz genre layer
  (recording-level genres). No API key; the email is the required
  User-Agent identifier per MB policy. Empty → layer skipped.
- `DISCOGS_KEY` / `DISCOGS_SECRET` — enable the Discogs genre + style
  layer. Free credentials at `discogs.com/settings/developers`. Both
  must be set; either empty → layer skipped.
- `VIBERATE_API_KEY` — paid trend source. Optional by design
  (Constraint #1).

The three genre layers stack: Last.fm alone gives a working but coarser
vector; MusicBrainz recovers per-track signal; Discogs adds curated
sub-genre styles. Any subset (or none) is valid — see step 3.4.

ReccoBeats supplies audio features and needs **no** key — toggle it on
the Sources screen.

### DB schema

```sh
pnpm install
pnpm db:init     # vector extension + drizzle generate + migrate
```

`db:init` is idempotent — safe to re-run after `git pull`.

### Gate

```sh
pnpm check && pnpm typecheck && pnpm test
```

Green is the prerequisite. `pnpm test` includes 8 testcontainers
suites — Docker daemon must be running, and the first run pulls
`pgvector/pgvector:pg16`. Re-run if a Postgres container loses the
port-bind race under parallel startup contention.

## 2. Boot

```sh
pnpm dev
```

Brings up three concurrent processes — `api` on `:3000`, `web` on
`:5173`, `mastra dev` Studio on `:4111`. The compose Postgres comes
up implicitly via the `dev` script.

Stop with `Ctrl-C`; then `pnpm dev:stop` to bring the compose Postgres
down.

## 3. Verification walk

Each step has a pass condition. Bail and file a fix if any of them
fails.

### 3.1 Login

Open `http://localhost:5173`. Log in with `ADMIN_PASSPHRASE`.

**Pass:** sidebar + 6 placeholder screens render. Wrong passphrase
rejects without leaking which field was wrong.

### 3.2 Setup → cold-start

Two paths — pick one.

**(a) Editorial playlist.** Setup screen → "cold-start playlist" → paste
a **Spotify-owned** playlist URL (Today's Top Hits, RapCaviar, anything
in "Made by Spotify"). User-generated playlists return 403 under Client
Credentials — that's the LAB-20/21 cliff documented in
`docs/SOURCES.md`.

**(b) Paste track URLs (LAB-20, works for any playlist).** Setup screen
→ "cold-start: paste track URLs". In Spotify desktop: open the playlist
→ ⌘A → right-click → Share → Copy Spotify URIs. Paste; one per line.

**Pass:** counter reads `N assigned • M spawned • K joined`. Setup's
"counts" stat row updates (`tracks` ≥ N).

### 3.3 Ingest more

Console → **"Run daily pipeline now"**. This fans out across enabled
adapters (Spotify search + Last.fm) and runs the full pipeline:
pull → enrich → bucket → retrain → recommend → surface.

**Pass:** `pipeline: ok`. New rows in Rating Queue (sidebar `01`).
Each row has why-surfaced copy (agent output or fallback) and a Scope
viz with the winner sub-scores.

### 3.4 Genre enrichment — multi-source layering (LAB-23)

Enrichment in 3.2/3.3 runs three genre layers in order — Last.fm
`artist.getTopTags` → MusicBrainz recording → Discogs master/release —
each gated on its own env credentials (see Prereqs). Tags merge
additively into `track.genres`; `track.genre_sources_processed` records
which sources reached each track. Inspect the result against the local
DB:

```sh
docker compose exec postgres psql -U cratedigger -d cratedigger -c \
  "SELECT artist, title, mbid, genre_sources_processed, genres \
   FROM track WHERE cardinality(genres) > 0 \
   ORDER BY updated_at DESC LIMIT 10;"
```

**Pass (all three creds set):** `genre_sources_processed` reads
`{lastfm,musicbrainz,discogs}` on tracks the pipeline reached, and
`genres` holds a merged, de-duplicated set — Discogs styles
(`Indietronica`, `Synth-pop`) sitting alongside Last.fm tags. A track
that went dark under LAB-22 — e.g. The Shins / "New Slang" — now carries
a populated genre vector and a resolved `mbid`. (`genre_sources_processed`
lists a source even when it returned nothing — that's the "tried, no
data" marker that stops re-fetching, not a failure.)

**Pass (graceful degradation):** stop the app, blank
`MUSICBRAINZ_CONTACT_EMAIL` + `DISCOGS_KEY`/`DISCOGS_SECRET` in `.env`,
re-boot, and re-run the daily pipeline. It completes cleanly;
`genre_sources_processed` on newly-reached tracks reads just `{lastfm}`,
and bucketing still works on the Last.fm-only vector. Each layer is
independent — any subset, or none, is valid. Restore the keys before
moving on.

> **Genre skews to the artist, not the track — by design.** Two of the
> three layers are coarse-grained: Last.fm `artist.getTopTags` is
> _artist_-level (the dominant baseline) and Discogs is _master/release_-
> level. Only MusicBrainz is _recording_-level (per-track), and it only
> contributes when the recording MBID resolves **and** carries its own
> genre tags — often it returns nothing. Net effect: a track inherits its
> artist's identity. Extreme's "More Than Words" (an acoustic ballad)
> lands in **metal**; an NDW track by a new-wave-tagged artist lands in
> **electronic**. The single label is then `derivePrimaryGenre`
> (`embedding.ts`) mapping the merged tags onto a fixed genre _slot_ via
> longest-keyword match — so off-table genres (e.g. NDW) collapse into
> the nearest slot. This is the accuracy ceiling of artist-level tagging,
> not a bug.

### 3.5 Rate ~30 tracks

Queue screen. `J` = dislike, `K` = skip, `L` = keep. Mix freely; aim
for ≥30 ratings with ≥10 keeps to give bucketing something to find.

**Pass:** queue depth decrements. Each rating tags `model_version`
(visible in the surface_event row server-side; not surfaced in UI).

### 3.6 Buckets emerge

Buckets screen (sidebar `02`).

**Pass:** centroid radar renders; cold-start seeds carry the seed badge.
A varied cold-start seed should yield **several genre-differentiated
buckets**, not the 1–2-bucket collapse that the pre-LAB-22 genre outage
produced — if a 100-track varied seed still falls into ≤2 buckets, genre
enrichment isn't reaching tracks (re-check step 3.4).

**On bucket names — read this before flagging `"<genre> (auto)"` as a
bug.** Naming is **lazy (LAB-25)**: every new bucket — spawned by the
cold-start seed or the daily pipeline — ships with the deterministic
placeholder `"<genre> (auto)"` until it reaches **N ≥ 3 members**. Below
that threshold there is no signal to name from; the `bucket-namer` agent
is held back on purpose. Once a bucket crosses N ≥ 3 (either organically
during a daily pipeline run or because the user clicks the "backfill
placeholders" button on the Buckets screen), the agent names it from the
aggregated member-genre distribution + centroid audio profile — not the
founding track's genre.

So at small cohort sizes, `"<genre> (auto)"` is **expected, not a
misconfiguration**. The rename pass is idempotent: re-running it won't
churn names that aren't drifting, and a centroid that hasn't moved past
the drift threshold (`pipeline-steps.ts: RENAME_DRIFT_THRESHOLD = 0.95`)
isn't eligible. Manual `rename` on the Buckets screen
(`buckets.rename`) still works for explicit overrides — human-renamed
buckets are deliberately ineligible for auto re-naming.

Two buckets sharing a placeholder name (e.g. two `"alternative (auto)"`)
is also expected, not a dedupe failure: clustering keys on the 64-dim
audio+genre **vector**, not the label. Two same-genre tracks more than
the spawn threshold apart in cosine each spawn their own bucket and both
carry the shared placeholder until each independently reaches N ≥ 3 and
gets a centroid-descriptive name (likely distinct, since their centroids
disagreed enough to spawn separately in the first place).

### 3.7 Console — novelty knob bumps `model_version`

Console → drag novelty knob → release.

**Pass:** the **novelty knob** (a.k.a. `refill λ`) commits and bumps
`refill v{N+1}` via the chip below the ranking row. Other controls
(sourceMix / dailyCap / queueCeiling / spawn / merge / split) commit
silently — no version bump. Active versions panel reflects the new id.

### 3.8 Analyzer KPIs

Analyzer screen (sidebar `03`).

**Pass:** `keepRate`, `P@10`, `P@25`, `genreEntropy` populate; daily
keep-rate spark renders. Bucket purity column lists every bucket with
1 − dislikeRate. Counterfactual replay table re-ranks historical pools
under the selected broad version — agreementRate < 1 when comparing
across versions confirms Constraint #2 + #3 wiring.

### 3.9 Source failover

Sources screen (sidebar `05`) → disable Spotify → Console → "Run daily
pipeline now".

**Pass:** pipeline completes without error. Last.fm continues to
contribute candidates (visible in the next surfaced events' source
mix). Re-enable Spotify before moving on.

### 3.10 Audio coverage

Console → Active versions panel → `audio coverage`.

**Pass:** `audio coverage` reads `N% (M/T)`. ReccoBeats returns no
features for some long-tail tracks — that's expected. The KPI exists to
make coverage rot visible if ReccoBeats breaks (`docs/SOURCES.md` →
"ReccoBeats — bus factor 1").

### 3.11 Taste round-trip (Constraint #8)

Setup screen → **"Export taste profile…"** → save the JSON.

Stop the app (`Ctrl-C` on `pnpm dev`). Wipe the DB:

```sh
docker compose down -v && docker compose up -d postgres && pnpm db:init
```

Re-boot (`pnpm dev`), log back in, Setup → **"Import taste profile…"** →
select the saved JSON.

**Pass:** counter reads `imported B buckets • +T tracks • R ratings`.
Buckets screen lists the same buckets (centroids recomputed on import,
member counts match). Queue depth restores.

## 4. Close-out

`pnpm check && pnpm typecheck && pnpm test` — green is still the gate
after the walk. Anything you tripped on goes in `PROGRESS.md` under
the next LAB issue, with a one-line "found by" reference back to the
runbook step.
