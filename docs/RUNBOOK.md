# Build & Test Runbook

End-to-end verification walk for Crate Digger. Pick this up on a fresh
checkout to confirm every constraint from `PLAN.md` is wired through —
prereqs, boot, the full data flow, and the taste-profile round-trip.

Originally lived in LAB-1's Linear description. Refreshed after LAB-4
(ReccoBeats audio features) and LAB-20 (paste-track-URLs cold-start)
moved past the data-sourcing block the original walk hit. See
`docs/SOURCES.md` for the underlying Spotify reality this walk works
around.

> ⏸️ **In flight — LAB-22.** During a live walk in late May 2026,
> step 3.2 surfaced that Spotify `/v1/artists/{id}` now returns
> `"genres": null` on new Dev Mode apps. Bucketing collapsed to
> audio-only clustering (107 varied tracks → only 2 buckets).
> A new, improved tagging mechanism (Last.fm `artist.getTopTags`,
> with per-artist caching and a multi-artist-credit split) is in
> review as PR #15 / branch `lab-22-lastfm-tags-genre`. **Resume
> this walk from step 3.2 once LAB-22 merges.** Until then, expect
> `primary_genre` to be null and only 1–2 buckets to emerge from
> any cold-start seed. The rest of the walk (rating, knob bumps,
> Analyzer, source failover, taste round-trip) is unaffected.

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
  metadata + genres. **Owner of the Dev Mode app must hold Spotify
  Premium** as of 2026-02-06 (`docs/SOURCES.md`). No localhost
  exemption.
- `SPOTIFY_REDIRECT_URI` — defaults to
  `http://127.0.0.1:3000/api/auth/spotify/callback`. Must match the
  Redirect URI registered in the Spotify Developer Dashboard **exactly**,
  and must use `127.0.0.1` — Spotify no longer accepts `localhost`.
- `ANTHROPIC_API_KEY` — bucket auto-naming, why-surfaced copy, playlist
  parser. Without it, agents fall back to deterministic placeholders;
  the app still works.
- `LASTFM_API_KEY` — Last.fm ingest. Free key at
  `last.fm/api/account/create`.
- `VIBERATE_API_KEY` — paid trend source. Optional by design
  (Constraint #1).

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

### 3.4 Rate ~30 tracks

Queue screen. `J` = dislike, `K` = skip, `L` = keep. Mix freely; aim
for ≥30 ratings with ≥10 keeps to give bucketing something to find.

**Pass:** queue depth decrements. Each rating tags `model_version`
(visible in the surface_event row server-side; not surfaced in UI).

### 3.5 Buckets emerge

Buckets screen (sidebar `02`).

**Pass:** ≥1 bucket with an auto-name (not `"<genre> (auto)"` — that's
the deterministic fallback; the Anthropic agent should overwrite when
`ANTHROPIC_API_KEY` is set). Centroid radar renders. Cold-start seeds
carry the seed badge.

### 3.6 Console — novelty knob bumps `model_version`

Console → drag novelty knob → release.

**Pass:** the `refill λ` knob commits silently (no version bump for
sourceMix / dailyCap / queueCeiling / spawn / merge / split tweaks);
**refill λ** commits and bumps `refill v{N+1}` via the chip below the
ranking row. Active versions panel reflects the new id.

### 3.7 Analyzer KPIs

Analyzer screen (sidebar `03`).

**Pass:** `keepRate`, `P@10`, `P@25`, `genreEntropy` populate; daily
keep-rate spark renders. Bucket purity column lists every bucket with
1 − dislikeRate. Counterfactual replay table re-ranks historical pools
under the selected broad version — agreementRate < 1 when comparing
across versions confirms Constraint #2 + #3 wiring.

### 3.8 Source failover

Sources screen (sidebar `05`) → disable Spotify → Console → "Run daily
pipeline now".

**Pass:** pipeline completes without error. Last.fm continues to
contribute candidates (visible in the next surfaced events' source
mix). Re-enable Spotify before moving on.

### 3.9 Audio coverage

Console → Active versions panel → `audio coverage`.

**Pass:** `audio coverage` reads `N% (M/T)`. ReccoBeats returns no
features for some long-tail tracks — that's expected. The KPI exists to
make coverage rot visible if ReccoBeats breaks (`docs/SOURCES.md` →
"ReccoBeats — bus factor 1").

### 3.10 Taste round-trip (Constraint #8)

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
