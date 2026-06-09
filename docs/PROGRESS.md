# Progress

Phase tracker. Update at the end of every phase. Newest at the top.

## LAB-61 — Bucket-member provenance (origin) + legacy eager-join cleanup

- **Status:** review
- **Branch:** `lab-61-bucket-member-provenance-origin-backfillcleanup-of-legacy`
- **PR:** _pending_ (stacks on LAB-60)
- **Scope landed:** `bucket_member.origin` enum
  (`seed_playlist | seed_track | seed_manual | discovery_keep`; `seed_manual`
  reserved — no live path yet) records membership provenance. Pre-LAB-52 the
  schema couldn't distinguish a deliberate cold-start seed from eager-join
  cruft (both = member with no rating), and a disliked legacy member
  self-anchored refill at keepSim=1.000. The column is NOT NULL with **no
  default**, so `$inferInsert` forces every insert site to stamp explicitly:
  `commitAssignmentInTx` takes `{origin, coldStartSeed}` and threads it into
  both join + spawn inserts; `AssignOptions.origin` is required;
  `seedBucketsFromTrackIds(db, ids, origin)` gets `'seed_playlist'` /
  `'seed_track'` from the two Setup flows; the `ingestRating` keep branch
  stamps `'discovery_keep'`; taste import stamps the exported origin (or
  keep-infers for legacy exports). The alreadyAssigned short-circuit never
  rewrites an existing origin.
  **Migration 0011 hand-edit pattern:** `pnpm db:generate` produced the pure
  ADD (no rename-prompt hazard), then the SQL was hand-edited into: CREATE
  TYPE → ADD COLUMN (nullable) → DELETE members rated-but-never-kept
  (dislike-no-keep + defer-only memberships go, **rating rows untouched** —
  no synthesized keeps, the eval substrate stays honest per Constraints
  #2/#3) → UPDATE keep-rated members to `discovery_keep` → UPDATE the rest to
  `seed_track` (generic: the schema has no record of which seed flow added
  them) → SET NOT NULL. A follow-up `db:generate` confirms zero snapshot
  drift; journal-tracked = exactly-once on every install. Two-phase
  migration-replay test (`tests/db/lab61-backfill.test.ts`) pins the mapping.
  **Reconcile sweep chained into db:migrate:** new
  `src/lib/bucketing/reconcile.ts` (+ `src/db/reconcile-buckets.ts` CLI;
  `db:migrate` = `drizzle-kit migrate && tsx … reconcile-buckets.ts`, so the
  Fly release_command repairs derived state on the same deploy). One
  transaction, idempotent, drift-gated: recompute every bucket whose
  member_count disagrees with reality (`recomputeBucketStats` extracted from
  the buckets router into `src/lib/bucketing/recompute.ts`; 0-member buckets
  deleted), delete pending recommendations referencing pruned buckets
  (`bucket_ids` is a plain int[], no FK), and — only when membership actually
  changed — re-derive all pending recommendations and bump the refill
  `model_version` exactly once (membership-gated, dynamic note naming the
  repaired buckets; parent chained, lambda carried forward under the
  app_config lock). **Drift-gated bump rationale:** the cleanup changes the
  refill keep-anchor set, so post-cleanup ratings must not attribute to the
  pre-cleanup version (Constraint #3) — but a clean install that repairs
  nothing keeps its version chain untouched, and re-runs are complete
  no-ops (no second bump, no recommendation churn; dismissed rows are never
  resurrected thanks to the (kind, bucket_ids) unique index).
  Refill anchors narrowed: `loadRefillableBuckets` + counterfactual
  `loadKeepsByBucket` filter on `KEEP_ANCHOR_ORIGINS` (all four today —
  defense-in-depth so a future origin doesn't silently anchor); the
  `loadKeepEmbeddingsForBucket` "narrow the SQL once Phase 5 lands" TODO is
  resolved — post-backfill, every member is a seed or a keep.
  Buckets screen: list/detail expose per-bucket origin tallies + per-member
  origin; the detail chips row renders "seeded N (playlist|tracks|manual) ·
  found M". Taste export/import (Constraint #8) round-trips origin
  (optional in the wire schema, version stays 1 — LAB-53 back-compat
  precedent).
- **Notes for future phases:**
  - **Residual gap (deliberate):** a seed member disliked AFTER LAB-61 still
    anchors refill — the cleanup only targets legacy eager-joins;
    differential weighting of dislike-rated seeds is out of scope here.
  - Generic backfill is lossy on purpose: playlist-seeded pre-LAB-52 installs
    get `seed_track` labels (cosmetic — no schema signal exists to recover
    the method; every seed origin anchors identically).
  - The recommendations panel on the Buckets screen is global-by-design;
    whether it should scope to the selected bucket is a follow-up UX call.

## LAB-60 — Surfacing eligibility gate (no re-queue of decided tracks)

- **Status:** review
- **Branch:** `lab-60-surfacing-re-queues-already-rated-tracks-no-rated-track`
- **PR:** _pending_
- **Scope landed:** A track rated on a prior run could reappear in the Rating
  Queue as a fresh unrated card — LAB-39's similar pull legitimately re-pulls
  tracks near bucket centroids, and nothing excluded already-rated ones.
  `runSurfacingBatch` (`src/lib/surfacing/pipeline.ts`) now applies an
  **eligibility gate at entry**, before ANY scoring, so every caller is covered
  and the refill pool, broad pool, `candidate_pool` logging, quality bars, and
  dryRun previews all see only the eligible set. Defer/neutral-only tracks stay
  eligible — defer means "later", and re-surfaces (pinned by test). The gate is
  a decision dedupe, NOT a taste penalty — Constraint #4 untouched (dislikes
  still only downweight other candidates). Constraint #2's pool definition
  amended: the candidate pool carries everything ingest pulled **that is still
  undecided and not already queued unrated** (one-line LAB-60 amendments to the
  Constraint #5 prose in CLAUDE.md + docs/PLAN.md). Observability:
  `excludedDecidedCount` + `excludedPendingCount` on `SurfacingResult` →
  `SurfaceSummary` → daily-pipeline workflow output; the shared run entry point
  (`src/server/pipeline-run.ts`) logs them in its completion line — the cron
  path's only sink, since no Mastra storage is configured — and
  `pipeline.runNow` returns them for the Console screen to render.
  Tests: new LAB-60 describe block in `tests/surfacing/pipeline.test.ts`
  (disliked not re-surfaced + absent from pool; kept bucket member doesn't
  re-surface into its own bucket under pure refill via the LAB-52 ingestRating
  commit path; deferred re-surfaces with a second event; pending-unrated dedupe
  keeps queue depth at 1; mixed-pool integrity; defer+dislike rule pin) plus a
  rate-then-re-surface integration assertion in the daily-pipeline smoke.
  Two exclusion categories (new `loadIneligibleTrackIds`, two index-backed
  queries — migration `0010` adds `rating_surface_event_idx` so the pending
  query's rating-side join is indexed too; it equally serves `queue.next`,
  queue depth, and `unratedSurfacedCount`):
  - **decided** — any keep/dislike rating, ever, regardless of model_version or
    a later defer. Ratings without a surface event (manual/import paths) count
    too: they are decisions.
  - **pending** — an unrated `surface_event` already queues the track; surfacing
    it again would create a duplicate queue card (verified unguarded gap, fixed
    alongside the ticket's decided-track case).
- **Decisions locked:**
  - **No `model_version` bump** — the gate changes pool _eligibility_, not
    scoring config; follows the LAB-53 ("bars are live config, no bump") and
    LAB-51 precedent. Replay is unaffected: every logged pool entry still
    carries its score.
  - **Exclude on keep/dislike only** (ticket text): neutral-only tracks remain
    eligible to re-surface — flagged as an open product question.
  - **Pipeline runs serialize in-process** — the gate (and the pre-existing
    queue-ceiling check) is read-then-write with no DB lock, so a Console
    "Run now" overlapping the 03:00 cron run could double-queue a track. Both
    trigger sites now share `runDailyPipeline` (`src/server/pipeline-run.ts`),
    which queues runs behind an in-process mutex. Sufficient because the app
    is a single process by spec; revisit with an advisory lock only if the
    pipeline ever runs from more than one process.
- **Notes for future phases:**
  - The dedupe is per-track, not per-(track, bucket): a track kept into bucket A
    never re-surfaces for bucket B either. Revisit only if cross-bucket
    re-surfacing ever becomes a feature.
  - **The gate is prospective only.** Deployments that hit the bug before this
    fix still carry unrated `surface_event` rows for already-decided tracks:
    `queue.next` keeps serving those cards and each one depresses
    `effectiveCap` until re-rated. No data migration ships here — deleting
    surface events discards logged candidate pools (Constraint #2), so cleanup
    is a deliberate manual step:

    ```sql
    -- decided zombies: unrated cards for tracks already keep/dislike-decided
    DELETE FROM surface_event se
    WHERE NOT EXISTS (SELECT 1 FROM rating r WHERE r.surface_event_id = se.id)
      AND EXISTS (SELECT 1 FROM rating r
                  WHERE r.track_id = se.track_id AND r.decision IN ('keep', 'dislike'));
    -- duplicate pending cards: keep only the oldest unrated event per track
    DELETE FROM surface_event se
    WHERE NOT EXISTS (SELECT 1 FROM rating r WHERE r.surface_event_id = se.id)
      AND se.id NOT IN (
        SELECT MIN(se2.id) FROM surface_event se2
        WHERE NOT EXISTS (SELECT 1 FROM rating r WHERE r.surface_event_id = se2.id)
        GROUP BY se2.track_id);
    ```

## LAB-53 — Quality-gated surfacing (drop the daily cap)

- **Status:** review
- **Branch:** `lab-53-replace-the-daily-cap-with-quality-gated-surfacing-pull`
- **PR:** _pending_ (stacked on LAB-52; top of the LAB-51→52→53 stack)
- **Scope landed:** Replaced the per-calendar-day `daily_surface_cap` with the
  three-knob model — **pull throttle** (LAB-51) + **per-ranker quality bar** +
  **queue ceiling** (the only hard count bound). Amends spec Constraint #5
  (CLAUDE.md + docs/PLAN.md).
  `runSurfacingBatch` (`src/lib/surfacing/pipeline.ts`) rewritten:
  `effectiveCap = max(0, queueCeiling − unrated)` — the daily-cap term and
  `todaysSurfacedCount` are gone. Refill now surfaces EVERY on-genre candidate
  whose keep-similarity clears the refill bar (default = spawn_threshold 0.7),
  dynamic count, can be >1/bucket (was round-robin top-1), highest refill score
  first, bounded by the ceiling; a candidate eligible for several buckets is
  assigned to its best-scoring one. Broad surfaces every candidate whose P(keep)
  clears the broad bar (default 0.5) that isn't already a refill winner, filling
  the remaining headroom (source-mix biased). Below-bar tracks get NO
  `surface_event` — they stay enriched + candidate-flagged (LAB-52 Option A);
  re-pulls dedupe to the existing row. Constraint #2 preserved: every
  `surface_event` still logs the FULL candidate pool, so counterfactual replay
  can re-derive above/below for any bar.
  Schema (migration `0008_cooing_gabe_jones` adds bars, `0009_true_ultimates`
  drops the cap): `daily_surface_cap` removed; `refill_quality_bar` (0.7) +
  `broad_quality_bar` (0.5) added. Wired through the params router, a Console
  "refill bar" / "broad bar" knob pair (daily-cap knob removed; queue-ceiling
  knob kept), and the taste profile (Constraint #8). Novelty loses its quota job
  (kept as a knob for LAB-42 to repurpose).
  Tests (surfacing suite rewritten; ~20 `dailyCapOverride` call sites across
  surfacing / evals / feedback migrated to `queueCeilingOverride` + bar
  overrides; 215 total green): queue-ceiling-bounds, ceiling-shrinks-with-
  unrated, below-bar-dropped (no event), surface-all-above-bar (dynamic count),
  and the headline refill->1/bucket.
- **Decisions locked:**
  - **Quality bars are live config, NOT version-pinned** (decided with Hans):
    Constraint #3 governs ranker _scoring_ config; bars gate which already-scored
    candidates surface, and `candidate_pool` keeps every score so replay is
    unaffected. No `model_version` bump on bar changes.
  - **Refill bar = a separate `refill_quality_bar` column defaulting to
    spawn_threshold's 0.7**, so surface strictness is tunable independently of
    bucket-spawn aggressiveness.
  - **Refill priority, broad fills the remainder** under the ceiling (refill =
    exploit, broad = explore); ordering only matters when the ceiling binds.
- **Notes for future phases:**
  - The drizzle drop+add tripped an interactive rename prompt (no TTY in this
    env) — generated as two migrations (add bars `0008`, then drop cap `0009`)
    to stay non-interactive. Watch for this whenever a column is replaced.
  - **LAB-42**: novelty needs a new job — bias the pull mix (explore→trending,
    exploit→similar) and/or the relative bars; it no longer splits quotas.
  - The "optional pre-enrichment genre gate" was NOT built — below-bar tracks
    are still fully enriched. Add a Last.fm-tag genre pre-filter before
    ReccoBeats/MB/Discogs if enrichment cost on dropped tracks bites.
  - With LAB-52 + LAB-53, refill anchors only on kept members, so a fresh
    install with no cold-start seed has nothing to refill until the user keeps —
    broad carries day one.

## LAB-52 — Candidate-flag bucketing (join only on approval)

- **Status:** review
- **Branch:** `lab-52-tracks-auto-join-buckets-before-review-flag-the-candidate`
- **PR:** _pending_ (stacked on LAB-51; LAB-53 stacks on this)
- **Scope landed:** The daily pipeline used to bucket every ingested track
  immediately — `bucketAndName` → `assignTrack` added each discovery track as a
  `bucket_member` AND moved the centroid before the user ever saw it (~120
  unreviewed tracks/run silently joined buckets and shifted centroids).
  Now discovery only **flags** a candidate: `bucketAndName` calls the new
  `flagCandidateBucket`, which computes + persists the track's
  embedding/primary_genre, runs the same LAB-45 primary-genre gate +
  nearest-centroid decision, and writes `track.candidate_bucket_id` /
  `candidate_score` (migration `0007_pale_whistler`) — **no `bucket_member`, no
  centroid move**. A NULL `candidate_bucket_id` = "would spawn a new bucket on
  keep."
  A track actually joins on **approval**: `ingestRating` gains a `keep` branch
  that calls `commitAssignmentInTx` (the eager spawn-or-join body, extracted and
  re-derived fresh inside the rating tx) to add the member, update the centroid,
  and clear the candidate flag. Re-derivation handles the would-spawn case and
  any bucket created since the flag; idempotent for already-member tracks; defer
  / dislike never commit. `assignTrack` (cold-start seeding) is unchanged — Setup
  still buckets eagerly; only daily discovery goes through review.
  The Queue surfaces the pending target: `queue.next` returns
  `pending { bucketId, bucketName, score }` and the card renders a
  "→ &lt;bucket&gt; &lt;score&gt;" chip ("joins this bucket if you keep it — not
  a member yet"). `bucketAndName`'s summary reshaped (candidateFlaggedCount /
  wouldSpawnCount / alreadyAssignedCount) through the workflow accumulator.
  Tests (4 new, 214 total green): flagging never creates a bucket/member
  (would-spawn) and flags the would-join target without joining; a keep commits
  - advances member_count + clears the flag; a defer leaves it pending. Step-by-
    step pipeline test updated to assert flag-only (zero buckets at ingest);
    bucket-seeding helpers switched to eager `assignTrack`.
- **Decisions locked:**
  - **Candidate stored as two nullable columns on `track`** (candidate_bucket_id
    - candidate_score), not a side table — matches how primaryGenre/embedding
      already live on track; one candidate per track is all the spec needs.
  - **Re-derive on keep**, not trust the stored candidate id — correctly handles
    the would-spawn case and same-genre buckets created since ingest.
  - **Approval = keep rating** (implicit); cold-start seeding stays eager.
- **Notes for future phases:**
  - LAB-53 (stacked next) reuses this exactly: below-bar dropped tracks stay
    enriched + candidate-flagged but unbucketed (its Option A).
  - Buckets screen does not yet show a per-bucket "pending candidates" list — the
    Queue chip is the primary review affordance; a Buckets pending view is a
    clean follow-up (needs a `buckets.detail`/`list` candidate count).
  - `loadKeepEmbeddingsForBucket`'s "scope to explicit keeps" TODO is now moot —
    every member is a keep.

## LAB-51 — Config-driven pull throttle (cut the ~125-track flood)

- **Status:** review
- **Branch:** `lab-51-limitpersource-floods-ingestion-125-tracksrun-lower-default`
- **PR:** _pending_ (stacked: base `main`; LAB-52 stacks on this)
- **Scope landed:** The daily pipeline ingested ~125 tracks/run — a single
  hardcoded per-source limit of 25 (`DEFAULT_PER_SOURCE_LIMIT`) reused for both
  the trending sweep and the LAB-39 taste-seeded similar fan-out
  (`SIMILAR_SEED_BUCKETS` = 5 → 5×25). Per Constraint #5 every pulled track is
  enriched + bucketed even though surfacing only shows a handful, so the DB
  ballooned with enriched-but-invisible rows.
  Three knobs added to `app_config` (migration `0006_tiny_maestro`):
  `trending_limit_per_source` (3), `similar_limit_per_source` (3),
  `similar_seed_buckets` (5) — worst case ≈ 3×adapters + 5×3 ≈ low tens.
  `pullAndEnrichTrending` now reads them from `app_config` with precedence
  `explicit option > config > DEFAULT_*`, splitting the single `limit` into
  independent trending vs similar per-source caps plus a configurable seed
  fan-out. Read **inside** the step (`loadPullThrottle`, mirroring
  `loadSpawnThreshold`) because both live trigger sites — cron and the Console
  "Run now" button — start the workflow with empty `inputData`, so a knob
  threaded through the workflow input would never take effect.
  `params` router + a new Console "ingestion" knob group expose all three; they
  travel with the taste profile (Constraint #8: `TASTE_CONFIG_SCHEMA` +
  export). `DailyPipelineInput.limitPerSource` demoted to a manual override.
  Tests (2 new, 210 total green): config drives the trending limit when no
  option is passed; the similar limit + seed-bucket cap are honoured
  independently of trending.
- **Decisions locked:**
  - **Split similar vs trending limits** (not one shared knob), so the operator
    pulls mostly on-taste + a little exploratory — this also lands LAB-53's
    "knob #1" (pull-size split) ahead of time.
  - **Config-read-inside** `pullAndEnrichTrending`, not threaded through the
    workflow input — the empty-`inputData` trigger sites made threading a no-op.
  - **No `model_version` bump** — pull throttle is ingestion volume, not ranker
    config (Constraint #3 governs scoring config; only `refillLambda` bumps).
- **Notes for future phases:**
  - LAB-53 stacks on this: reuses the similar/trending split as knob #1 and
    adds the per-ranker quality bar + queue-ceiling-only bound.
  - `min(0)` on the knobs lets the operator disable a pull mode (0 trending =
    similar-only; 0 seed buckets = trending-only); `selectBucketSeeds` already
    treats `maxBuckets <= 0` as a clean no-op.

## LAB-25 — Centroid-descriptive bucket naming + `(auto)` backfill

- **Status:** review
- **Branch:** `lab-25-rework-bucket-naming-centroid-descriptive-lazy-re-runnable`
- **PR:** _pending_
- **Scope landed:** Bucket naming reworked from "primary genre of the
  founding track" to centroid-descriptive aggregate, with lazy timing,
  drift-triggered re-runs, and a one-shot backfill of existing `(auto)`
  placeholders. The naming-layer fix flagged in LAB-24's verdict; the
  deeper pre-filter membership question is filed as LAB-36, deliberately
  out of scope.
  Bucket-namer agent (`src/mastra/agents/bucket-namer.ts`) input shape
  swapped from `{primaryGenre, sampleTracks}` to `{primaryGenre,
memberCount, genreDistribution, audioProfile, sampleTracks}` —
  aggregated member-genre counts together with the bucket's centroid
  audio means (`bucket.featureStats.mean`) together with the same
  handful of sample tracks. Instructions rewritten with explicit cues
  that map the 6 audio dims to natural-language descriptors (high
  acousticness with low energy ≈ ballads; high energy with high
  danceability ≈ dance; etc.) and that name from the SHARED character of
  the members, not any one tag or any one track. Sidesteps the LAB-24
  finding about `derivePrimaryGenre` ordering sensitivity. Model stays
  `anthropic/claude-haiku-4-5`.
  Pipeline changes (`src/mastra/lib/pipeline-steps.ts`): spawn-time
  naming is gone. `bucketAndName` no longer calls the agent for
  newly-spawned buckets; they ship with the deterministic
  `<primaryGenre> (auto)` placeholder from `defaultBucketName` and wait
  for the rename pass. New `renameEligibleBuckets(db, env)` walks every
  bucket, applies a pure `isRenameEligible(...)` rule, and names
  eligible buckets via the agent. Eligibility is any of: (a) still on
  the `(auto)` placeholder AND `memberCount ≥ 3` (first-time lazy
  threshold); (b) previously agent-named AND `memberCount ≥ 2 ×
last_named_at_count` (doubled); (c) previously agent-named AND
  cosine(centroid, `last_named_centroid`) < 0.95 (drift). Human-renamed
  buckets (real name with `last_named_at_count = NULL`) are
  deliberately ineligible — the rename pass never overwrites a user
  choice. Idempotent: re-running won't churn names without drift.
  Returns `{ eligibleCount, renamedCount, errorCount }`.
  Daily-pipeline workflow (`src/mastra/workflows/daily-pipeline.ts`):
  new `rename-eligible` step inserted between `bucket-and-name` and
  `retrain-broad`. Replaces the old `namedBucketCount` accumulator
  field with three new fields: `eligibleBucketCount`,
  `renamedBucketCount`, `renameErrorCount`.
  tRPC and UI: new `buckets.renamePlaceholders` mutation calls the
  same `renameEligibleBuckets` function as a manual button trigger.
  Buckets screen (`src/web/screens/buckets.tsx`) gains a "names" panel
  above the existing "recommendations" panel in the right column, with
  a "backfill placeholders" button mirroring the `recompute` pattern.
  Result chip reads `"{eligible} eligible · {renamed} renamed"` plus an
  optional errors tail.
  Schema delta: two new nullable columns on `bucket` via migration
  `0005_illegal_lizard.sql`. `last_named_at_count integer` stores the
  member count at the moment of the last successful agent naming, NULL
  on rows that still carry the deterministic `(auto)` placeholder.
  `last_named_centroid vector(64)` stores the centroid snapshot at the
  same moment, NULL until first naming. No data backfill needed:
  existing `(auto)` buckets correctly read as "never named, eligible at
  N ≥ 3".
  Tests (8 new and 1 updated, 182 total green).
  `tests/mastra/agents.test.ts`: bucket-namer fallback tests updated to
  the new input shape; new case verifies the `genreDistribution`-
  fallback path when `primaryGenre` is null.
  `tests/mastra/rename-eligibility.test.ts` (new, 7 cases): pure
  boundary pinning on `isRenameEligible` — below threshold, first-time
  at N=3 placeholder, human-rename guard, member-count doubling, drift
  below 0.95, no-rename when stable.
  `tests/mastra/daily-pipeline.test.ts`: spawn-time naming assertion
  replaced with the lazy expectation — every new bucket carries the
  `(auto)` placeholder and `lastNamedAtCount = NULL`.

- **Decisions locked:**
  - **Scope split**: keep this ticket as-spec'd (naming only). File
    the deeper pre-filter rework as a separate ticket (LAB-36). The
    `assign.ts:155` `primary_genre` exact-match candidate filter is
    the real "membership decision" lever that locks tracks to their
    artist-genre lane; rebalancing that is a `model_version` event
    and earns its own change window.
  - **Drift trigger**: dual signal — cosine drift < 0.95 OR member
    count doubled since last naming. The doubling check is bulletproof
    at small N where centroids move slowly per addition; the cosine
    check covers large clusters where individual joins barely budge
    the centroid but accumulated drift matters.
  - **Human-renamed buckets are sacred**: the rule treats "real name +
    `last_named_at_count NULL`" as a manual override and never
    re-names. The agent path always sets `last_named_at_count`
    alongside the name so the next eligibility check has the anchor.
  - **No backfill via `force` flag**: the eligibility rule is
    sufficient. The "backfill placeholders" button invokes the same
    `renameEligibleBuckets` as the daily step. Idempotent by
    construction.

- **Notes for future phases:**
  - **LAB-36 is the next architectural lever.** Even with
    centroid-descriptive naming, the "More Than Words → metal bucket"
    symptom only resolves once the bucket grows to ≥3 members. At the
    current 1-member-per-bucket density of the cold-start seed, the
    placeholder persists. The pre-filter rework in LAB-36 is what
    actually rearranges which tracks land in which bucket.
  - The bucket-namer prompt explicitly maps audio dims to mood
    descriptors — that mapping is the most likely place to tune if
    name quality looks off in practice. Bumping to Sonnet is a
    one-line change in `bucketNamerAgent`; keep Haiku unless eval
    shows the prompt hints aren't carrying enough signal.
  - `derivePrimaryGenre`'s ordering sensitivity (Spider Murphy Gang
    "rock" vs Extrabreit "electronic" on near-identical NDW genre
    lists) is now sidestepped _for naming_ but still drives
    membership through the pre-filter — LAB-36 problem.
  - `RENAME_DRIFT_THRESHOLD = 0.95` and the lazy-naming `N ≥ 3`
    constants are hardcoded in `pipeline-steps.ts`. Surface to
    `app_config` only if eval data shows we want to tune them; YAGNI
    until then.

## LAB-23 — Multi-source genre tagging (Last.fm artist + MusicBrainz + Discogs)

- **Status:** review
- **Branch:** `lab-23-multi-source-genre-tagging`
- **PR:** #16
- **Scope landed:** Layered MusicBrainz recording-level genres and
  Discogs master/release genres + styles on top of the Last.fm artist
  tags introduced in LAB-22. Each source gated on its own env
  credentials (`MUSICBRAINZ_CONTACT_EMAIL`, `DISCOGS_KEY` +
  `DISCOGS_SECRET`); pipeline degrades gracefully to whatever subset is
  configured. Tags merge additively (case-insensitive dedupe) into the
  unified `track.genres: text[]`; `embedding` is rebuilt at every
  source's pass.

  Pipeline order in `pullAndEnrichTrending` (and both `cold-start.ts`
  seed entry points):
  `ReccoBeats audio → Last.fm artist tags → MusicBrainz recording → Discogs master/release`.
  Last.fm runs first (cheap, per-artist cache); MB second (uses cached
  MBID where Last.fm `track.getInfo` populated it); Discogs last
  (slowest, 1200ms-paced).

  Schema delta: two new columns on `track` (migration `0004`):
  - `mbid text` nullable — MusicBrainz recording MBID, resolved lazily
    by the MB enricher via Last.fm `track.getInfo` and cached on the
    row. Partial index `WHERE mbid IS NOT NULL`.
  - `genre_sources_processed text[]` — per-source idempotency: each
    source ID is appended after a completed pass (success OR empty OR
    error), so a re-run never re-fetches. Backfilled to `['lastfm']`
    on existing enriched rows. GIN-indexed.

  Last.fm enricher (`src/lib/enrichment/lastfm-tags.ts`) refactor:
  - Idempotency guard switched from `cardinality(genres) = 0` to
    `NOT ('lastfm' = ANY(genre_sources_processed))` — distinguishes
    "never tried" from "tried, got empty" (Last.fm legitimately
    returns empty for some artists).
  - "Various Artists" artists skip the API call but still flag
    processed — artist axis is degenerate; MB and Discogs carry the
    signal.
  - Merge is now additive: read existing `track.genres`, union
    case-insensitively with returned tags, rebuild embedding.

  New modules:
  - `src/lib/enrichment/musicbrainz.ts` — MBID resolution chain
    (`track.mbid` → Last.fm `track.getInfo` → mark+skip), recording
    `?inc=genres+tags` lookup, 1 req/s limiter, `User-Agent:
CrateDigger/0.1 (mailto:<email>)`.
  - `src/lib/enrichment/discogs.ts` — master-first search + detail,
    falls back to release. Genres + styles merge in. 1200ms limiter
    (≈50/min) under the 60/min auth ceiling. Consumer key/secret as
    URL params; User-Agent header.

  Tests:
  - `tests/enrichment/lastfm-tags.test.ts` updated: new idempotency
    semantics, additive merge, Various Artists skip, empty-result
    flagging.
  - `tests/enrichment/musicbrainz.test.ts` new (7 cases): cached-MBID
    short-circuit, Last.fm resolution + persistence, no-MBID skip, MB
    404 skip, additive merge, idempotency, no-creds no-op.
  - `tests/enrichment/discogs.test.ts` new (7 cases): master-hit,
    release fallback, both-miss skip, additive merge, auth params /
    User-Agent header, no-creds no-op, idempotency.
  - `tests/mastra/daily-pipeline.test.ts` asserts the new
    `mbGenresUpdated` + `discogsGenresUpdated` summary fields.
  - 173/173 tests green.

- **Decisions locked:**
  - **Idempotency model: Option 1 — `genre_sources_processed: text[]`
    column.** Chose this over per-source timestamp columns (Option 2)
    and a normalised `track_enrichment` side table (Option 3) because
    (a) one-and-done enrichment is fine for a single-user OSS app,
    (b) avoids column proliferation as new sources are added, (c) clean
    upgrade path to Option 2/3 later via a single `ALTER TABLE`, and
    (d) distinguishes "never tried" from "tried, got empty" cleanly.

    **Upgrade signals to Option 2 (per-source timestamp columns):**
    - We want a "refresh tags older than N days" policy.
    - MB or Discogs catalogues improve over time and we want to
      backfill stale entries.
    - We add a 4th/5th source (Bandcamp, Beatport, etc.) — column
      proliferation only gets ugly past ~5.

    **Upgrade signals to Option 3 (`track_enrichment` side table):**
    - We care about enrichment audit history (which source returned
      what, when).
    - We want per-source error/tag-count metadata for telemetry.
    - We ever scale beyond 5 sources or run multi-tenant.

  - **Discogs lookup: master-first with fallback to release.** Master
    gives canonical styles; release fallback covers the long tail.
    2–3 API calls per track.

  - **MBID persistence: `track.mbid` nullable column.** Resolved
    lazily via Last.fm `track.getInfo` during MB enrichment, cached
    on the row. LAB-22 flagged this as future work; LAB-23 ships it.

- **Notes for future phases:**
  - Recording-level MB coverage on the user's catalogue is the
    sample-size question to validate empirically: if `<30%` of MBID-
    resolved tracks return non-empty `genres`/`tags`, Option B-lite
    (skip Discogs) becomes a defensible simplification. Easy enough
    to measure once a few hundred tracks have flowed through.
  - The `genres` array is now potentially noisier: Discogs styles
    include capitalised forms ("Synth-pop"), MB tags include
    moods/non-genres. The 58-slot keyword matcher in `embedding.ts`
    drops anything it doesn't recognise — but the displayed
    `track.genres` may surface noise in UI. If that becomes a
    problem, introduce a "display-curated" subset (e.g. only the
    slots that lit up) at the surfacing layer.
  - Live-API smoke probe (The Shins — "New Slang") is the
    deterministic regression check: it failed under LAB-22's
    track.getTopTags and should now produce Last.fm artist tags +
    MBID + MB recording genres + Discogs styles end-to-end.

## LAB-1 — Build & Test runbook close-out

- **Status:** review
- **Branch:** `lab-1-runbook-refresh`
- **PR:** #14
- **Scope landed:** Refreshed the LAB-1 build & test runbook for the
  post-LAB-4 + LAB-20 reality and lifted it from the Linear issue
  description into a permanent doc — `docs/RUNBOOK.md`. Ten-step
  verification walk: prereqs (Docker, `.env`, `pnpm db:init`,
  `pnpm check && pnpm typecheck && pnpm test`), boot, login, Setup
  cold-start (editorial-playlist path OR LAB-20 paste-track-URLs path),
  Console "Run daily pipeline now", rate ~30 tracks, buckets emerge,
  novelty/refill-λ knob bumps `model_version` (Constraint #3), Analyzer
  KPIs + counterfactual replay (Constraint #2), Sources failover with
  Spotify disabled (Constraint #1), `audio_feature_coverage` KPI sanity
  check, taste profile JSON round-trip through a wiped DB (Constraint #8).
  Each step names its pass condition. Gotchas called out at the prereq
  step rather than mid-walk: Spotify Dev Mode owner must hold Premium,
  redirect URI must be `127.0.0.1` (not `localhost`), ReccoBeats has no
  key (toggle on Sources), Anthropic key optional (agents degrade to
  deterministic placeholders). Phase 8's `docs/DEPLOY.md` carried in
  alongside — three-tier deploy walkthrough (local / single VM / Fly.io)
  plus the OSS GitHub Actions security model that pairs with the
  Terraform module landed in PR #10. No code or test changes.
- **Notes for future phases:**
  - LAB-1 itself is now a docs artefact, not an open verification debt.
    Pivot point: as soon as the data flow surfaces a real bug during
    the walk, file the fix under a new LAB-N rather than re-opening LAB-1.
  - The runbook references `docs/SOURCES.md` for Spotify cliffs rather
    than restating them — keep SOURCES authoritative for any future
    cliff (LAB-21 user OAuth will land there too).
  - DEPLOY.md is referenced from `README.md` but not yet from `PLAN.md`
    or `CLAUDE.md`. Leave that to the deploy-time follow-up.

## LAB-22 — Genre signal swap to Last.fm tags

- **Status:** review
- **Branch:** `lab-22-lastfm-tags-genre`
- **PR:** _pending_
- **Scope landed:** Found during LAB-1 runbook verification: every
  `GET /v1/artists/{id}` response on a post-2024-11-27 Spotify Dev Mode
  app returns `"genres": null`, not a populated array. Confirmed with
  multiple artists (The Shins, Band of Horses, etc.) under valid Client
  Credentials. Consequence: the 58-slot genre half of the embedding
  went dark, `primary_genre` was null on every track, bucketing
  collapsed to audio-only clustering (a 107-track seed produced only 2
  buckets).
  Fix: new `src/lib/enrichment/lastfm-tags.ts` calls Last.fm
  `artist.getTopTags` with `autocorrect=1`, filters tags by
  `count >= 10`, caps at top 8, then rebuilds `genres` /
  `primary_genre` / `embedding`. Raw tag strings flow into the
  existing keyword-matched 58-slot taxonomy in `embedding.ts` with
  zero taxonomy rewrite — Last.fm's tag vocabulary happens to map
  cleanly onto our slot keywords. Within an enrichment run, a
  per-artist cache collapses N-tracks-by-one-artist to a single
  Last.fm call. `primaryArtist()` helper splits Spotify's
  comma-joined multi-artist credits ("The Shins, James Mercer") on
  the way out so Last.fm autocorrect can resolve. Idempotent via the
  same `cardinality(genres) = 0` cache the old enricher used.
  Graceful degradation on the in-body API error envelope (`error: 6
"artist not found"`), HTTP non-200, and single-tag-as-object
  responses.

  Track-level vs artist-level: we initially built on
  `track.getTopTags`, but live-API verification under LAB-1 walk
  showed track-level returns empty across the board on the live
  Last.fm API as of mid-2026 (confirmed against multiple popular
  tracks). Artist-level still serves rich tag clouds, so the
  enricher uses it. Semantic tradeoff is acceptable: every track by
  an artist shares a genre vector (matches bucketing intent —
  same-artist tracks should cluster). One-off cross-genre side
  projects lose track-specific tagging.
  Dead Spotify path deleted: `src/lib/enrichment/spotify-metadata.ts`
  and `tests/enrichment/spotify-metadata.test.ts` removed. Call sites
  in `src/lib/bucketing/cold-start.ts` (both seed entry points) and
  `src/mastra/lib/pipeline-steps.ts` (daily pipeline) swapped to the
  new module.
  Docs: `docs/SOURCES.md` gains a "Mid 2026 — artist.genres returns
  null" cliff entry under the Spotify section, a "Genres via Last.fm
  tags" section documenting the swap, and the depended-on endpoints
  table drops `GET /artists/{id}`.
  Tests: new `tests/enrichment/lastfm-tags.test.ts` (4 `primaryArtist`
  unit cases + 7 enricher cases — count threshold + primary-genre +
  embedding rebuild, idempotency, per-artist cache, multi-artist
  split, in-body error envelope, no-creds no-op, single-tag-as-object).
  Daily pipeline test comment updated to reflect the new enricher.

- **Notes for future phases:**
  - Coverage caveat: Last.fm's catalogue is biased toward Western
    indie/rock/electronic. Long-tail / non-Western tracks may return
    no tags — the system still buckets on audio alone. The
    `audio_feature_coverage` KPI surfaces ReccoBeats rot but there is
    no symmetric `genre_coverage` KPI yet; if Last.fm coverage proves
    spotty in practice, add one.
  - `mbid` is not persisted on `track` rows; lookups use the
    `(artist, title)` pair. If match rate ever proves insufficient,
    plumb `mbid` through the resolver and prefer it over the pair.
  - If Spotify ever turns `artist.genres` back on, the Last.fm path is
    fine to keep as the primary — adding Spotify back as a
    supplementary signal would be the rebuild path, not a wholesale
    swap.

## LAB-4 — ReccoBeats audio-features swap + Feb 2026 Spotify adaptation

- **Status:** review
- **Branch:** `lab-4-swap-spotify-audio-features-for-reccobeats-adapt-to-feb-2026`
- **PR:** https://github.com/hanscl/crate-digger/pull/12
- **Scope landed:** Spotify retired `/audio-features` for apps registered after
  2024-11-27, so audio features now come from **ReccoBeats**. New
  `src/lib/enrichment/reccobeats.ts` (`fetchAudioFeatures` + `enrichAudioFeatures*`)
  — no-auth API keyed by Spotify track id, idempotent via the existing
  `audio_features IS NULL` cache, opportunistic `isrc` null-backfill;
  `key`/`mode` deferred (embedding-dim change). New
  `src/lib/enrichment/rate-limit.ts` — hand-rolled 2 req/s limiter +
  `fetchWithRetry` honouring `Retry-After` on 429 with exponential backoff.
  `spotify-features.ts` deleted and replaced by
  `src/lib/enrichment/spotify-metadata.ts` — genres-via-artist-lookup
  (individual `GET /artists/{id}`, batch endpoints gone Feb 2026), rebuilds
  `genres` / `primary_genre` / `embedding`. Spotify adapter
  (`src/lib/ingestion/spotify.ts`) adapted to Feb 2026 Dev Mode: `/search`
  offset-paginated at the new `limit=10` cap (≤5 pages), `/recommendations`
  branch removed. New `audioFeatureCoverage` eval metric (added to
  `Kpis` / `loadKpis`), surfaced read-only on the Console screen. ReccoBeats
  toggle: `app_config.sources_enabled` gains a `reccobeats` key (migration
  `0003_clumsy_eddie_brock.sql`, with a backfill `UPDATE` for the existing
  singleton row), exposed as an "Enrichment" toggle row on the Sources
  screen (`sources` router `list` now returns `{ adapters, enrichment }`).
  Daily pipeline + cold-start rewired: ReccoBeats features → Spotify genres →
  bucket. New `docs/SOURCES.md` documents the post-2024 / post-Feb-2026
  Spotify reality.
  Tests: `tests/enrichment/rate-limit.test.ts` (7, fake-timer 429/spacing),
  `tests/enrichment/reccobeats.test.ts` (mapping, batching, graceful
  degradation, toggle gate, idempotency), `tests/enrichment/spotify-metadata.test.ts`
  (genre union, embedding rebuild, idempotency, artist cache, no-creds);
  `audioFeatureCoverage` block in `tests/evals/metrics.test.ts`;
  `tests/mastra/daily-pipeline.test.ts` extended with a ReccoBeats fetch stub
  and a regression guard that the enrich phase never calls Spotify
  `/audio-features`.
- **Notes for future phases:**
  - Manual prerequisite: register a new Spotify Dev Mode app under a Premium
    account and put the credentials in `.env` — the audio half stays dark
    without working Spotify ingest feeding `spotify_id`s to ReccoBeats.
  - The ReccoBeats response envelope is parsed defensively but unverified
    against the live API — re-confirm if `audio_feature_coverage` looks wrong.
  - LAB-5 (related) tracks a manual audio-feature paste fallback for when
    ReccoBeats is unavailable.
  - `enrichAllGenresFromArtists` rebuilds embeddings — running it over the
    existing catalogue should be followed by a bucket centroid recompute.

## Phase 1 — Skeleton + DB

- **Status:** review
- **Branch:** `phase-1-skeleton`
- **PR:** https://github.com/hanscl/crate-digger/pull/1
- **Scope landed:** repo scaffold, pnpm + Node 24 + TS strict, oxlint + oxfmt + lefthook,
  docker-compose with pgvector, Dockerfile, `.env.example`, Drizzle schema for all 10 tables
  (`track`, `track_source`, `bucket`, `bucket_member`, `model_version`, `surface_event`, `rating`,
  `search_run`, `bucket_recommendation`, `app_config`), Hono + tRPC hello + cookie auth,
  Vite + React + Tailwind + IBM Plex shell with sidebar + 6 placeholder screens, `docs/PLAN.md`,
  `docs/PROGRESS.md`, `CLAUDE.md`, GitHub Actions CI.
- **Notes for future phases:** none yet.

## Phase 2 — Ingestion + enrichment

- **Status:** review
- **Branch:** `phase-2-ingestion` (rebased onto `main` after #1 merged)
- **PR:** https://github.com/hanscl/crate-digger/pull/3 (supersedes #2)
- **Scope landed:** `SourceAdapter` interface + registry; Spotify adapter
  (Client Credentials, search/trending/similar, ISRC pass-through); Last.fm
  adapter (search/similar/chart top tracks); Viberate adapter stub; ISRC-first
  enrichment resolver with fuzzy fallback (`fast-fuzzy`) and conflicting-ISRC
  guard; Spotify audio-features fetcher with widen-only backfill; first drizzle
  migration generated (`migrations/0000_*`); testcontainers-pg integration
  harness; adapter contract test (16 cases) + enrichment idempotency test
  (4 cases including remix / distinct-ISRC guard).
- **Notes for future phases:**
  - `drizzle-kit` bumped to `^0.31` so generate works under TS `target: ES2023`.
  - Tests require a working Docker daemon (testcontainers spins up
    `pgvector/pgvector:pg16`); CI sets `TESTCONTAINERS_RYUK_DISABLED=true`.
  - Spotify `/v1/recommendations` and `/v1/audio-features` were retired for
    apps registered after 2024-11-27. The code paths are present but degrade
    silently to empty / no-op for new apps; Phase 3+ may need a handcrafted-
    features fallback.

## Phase 3 — Embedding + bucketing

- **Status:** review
- **Branch:** `phase-3-bucketing`
- **PR:** https://github.com/hanscl/crate-digger/pull/4
- **Scope landed:** 64-dim embedding builder (6 audio dims and 58-slot
  genre multi-hot taxonomy, plus `derivePrimaryGenre` and cosine similarity)
  in `src/lib/embedding.ts`; pure Welford helpers (`updateCentroid`,
  `addFeatureSample`, `featureVariance`) in `src/lib/bucketing/centroid.ts`;
  transactional spawn-or-join assignment with primary-genre filter in
  `src/lib/bucketing/assign.ts`; cold-start seeding in
  `src/lib/bucketing/cold-start.ts` (track-IDs entry point and a
  Spotify-playlist-URL wrapper that reuses the Phase 2 enrichment pipeline).
  `assignTrack` runs the entire decision (membership probe, candidate
  fetch, spawn-or-join, centroid math, writes) in one transaction, takes
  a `SELECT … FOR UPDATE` on the chosen bucket when joining, and relies
  on a unique index on `bucket_member.track_id` (migration `0001_*`) to
  detect race-losers; the outer call retries once on a unique-violation.
  Tests: pure embedding/centroid suites plus a testcontainers
  `assign.test.ts` covering the four contract cases (within-threshold
  join, outside-threshold spawn, no-genre-match spawn, Welford
  correctness), idempotency, and two concurrency regressions (parallel
  calls for the same track collapse to one membership; parallel joins
  to the same bucket round-trip the centroid and member count
  correctly). 55 tests total.
- **Notes for future phases:**
  - pgvector stores `real` (float32); centroid precision tops out around
    6-7 decimals when round-tripped through the DB. Keep that in mind when
    Phase 4 ranking math compares persisted vs in-memory vectors.
  - Spawned bucket names default to `"<primaryGenre> (auto)"`. The Phase 6
    Mastra `bucket-namer` agent is expected to overwrite these on spawn.
  - `assignTrack` uses `app_config.spawnThreshold` (default 0.7) when no
    explicit option is passed; tests force the value for determinism.

## Phase 4 — Ranking + surfacing

- **Status:** review
- **Branch:** `phase-4-ranking`
- **PR:** https://github.com/hanscl/crate-digger/pull/5
- **Scope landed:** pure refill ranker (`src/lib/ranking/refill.ts`) — `score
= mean cosine(c, keep_i) − λ · mean cosine(c, dislike_i)`; broad classifier
  (`src/lib/ranking/broad.ts`) — hand-rolled batch logistic regression on the
  64-dim embedding with L2 reg, untrained-fallback to a class prior so
  surfacing works on day 0; model versioning (`src/lib/ranking/version.ts`)
  with `bumpModelVersion`, `ensureActiveModelVersion`,
  `getActiveModelVersion`, `getActiveConfig`, lineage walker — independent
  refill/broad version chains, `parent_id` lineage, `app_config.active_*`
  pointers swung in a single transaction; surfacing pipeline
  (`src/lib/surfacing/pipeline.ts`) — novelty knob mixes refill/broad quotas,
  daily cap + queue ceiling enforced HERE (Constraint #5), source-mix
  bookkeeping as soft preference (never a hard filter), refill phase
  round-robins across refillable buckets and surfaces top-1 per slot;
  surface_event writer (`src/lib/surfacing/log.ts`) — every surface_event
  records the FULL candidate pool with sub-scores (Constraint #2 — the eval
  substrate). 25 new tests across `tests/ranking/{refill,broad}.test.ts`,
  `tests/surfacing/{pipeline,log}.test.ts`: refill/broad math (pure), Welford
  log of constraints (eval substrate, soft penalty, daily cap at surfacing,
  counterfactual replay determinism within float32 tolerance, model_version
  attribution). 80 tests total, all green.
- **Notes for future phases:**
  - Refill keeps = bucket members (cold-start seeds count as anchors). When
    Phase 5 lands explicit keep ratings, narrow `loadKeepEmbeddingsForBucket`
    to "members with explicit keep ratings"; the function shape stays.
  - Broad classifier serializes weights into `model_version.config` as
    `{weights, bias, trainedSampleCount, prior}`. Phase 5's retrain workflow
    calls `trainBroadClassifier` then `bumpModelVersion(db, "broad", config)`.
  - Counterfactual replay reproduces persisted scores within ~1e-5 due to
    pgvector's float32 storage; all replay tests use `toBeCloseTo(_, 5)`.
  - `runSurfacingBatch` accepts a candidate pool from the caller — Phase 6's
    `dailyPipeline` workflow chains ingestion → surfacing without surfacing
    reaching back into ingestion.
  - `ensureActiveModelVersion` is the single bootstrap seam — it
    idempotently mints initial `model_version` rows on first surfacing run
    and updates `app_config.active_*_version_id` pointers.

## Phase 5 — Feedback + evals

- **Status:** review
- **Branch:** `phase-5-feedback`
- **PR:** https://github.com/hanscl/crate-digger/pull/7
- **Scope landed:** rating ingestion (`src/lib/feedback/ingest-rating.ts`)
  — Constraint #3 attribution by reading `surface_event.model_version_id`
  pinned at surface time, falls back to active broad version for
  cold-start / import paths, increments `bucket.dislikeCount` only on
  dislike of a bucket member; broad retrain entrypoint
  (`src/lib/feedback/retrain.ts`) — pulls keep/dislike samples in a window,
  short-circuits `no_samples` and `single_class` cases without polluting
  the version chain, otherwise calls `trainBroadClassifier` +
  `bumpModelVersion("broad", ...)` with training-window stamps; merge/split
  recommendation heuristics (`src/lib/bucketing/recommendations.ts`) — same-
  primary-genre cosine ≥ `mergeThreshold` for merges, dislike rate ≥
  `splitDislikeRate` AND member count ≥ 4 for splits, idempotent dedupe by
  (kind, sorted bucketIds), never auto-applies (Constraint #7); eval
  metrics (`src/lib/evals/metrics.ts`) — `keepRate` (overall + by ranker /
  version / source with two-query design avoiding cross-source double
  counting), `precisionAtN` over N most recent surfaced events,
  `bucketPurity` = 1 − dislikeRate, `genreEntropy` (Shannon, raw + ln(k)
  normalized), `loadKpis` aggregate; counterfactual replay
  (`src/lib/evals/counterfactual.ts`) — re-scores historical
  `surface_event.candidate_pool` rows under a target version's config,
  reports per-event agreement vs original winner + agreement-rate +
  agreed-and-kept / disagreed-and-disliked counters, hard cap on event
  scan size (default 500). Schema additions: `RatingDecision`,
  `RecommendationKind`, `RecommendationStatus`, `BucketRecommendation`
  type exports.
  Tests (32 new, 112 total green): `tests/feedback/ingest-rating.test.ts`
  (5 cases — Constraint #3 attribution across a mid-flight retrain,
  active-version fallback, missing-event guard, dislike counter on
  member, no-op on keep / non-member); `tests/feedback/retrain.test.ts`
  (3 cases — no-samples + single-class skip, balanced retrain bumps
  version with weights set); `tests/bucketing/recommendations.test.ts`
  (6 cases — merge same-genre, no merge across genre, merge idempotency,
  split high dislike rate, no split for tiny buckets, split idempotency);
  `tests/evals/metrics.test.ts` (5 cases — keep-rate by ranker/source/
  version, P@N kept count, P@N empty, bucket purity math, genre entropy
  zero/uniform); `tests/evals/counterfactual.test.ts` (3 cases — same-
  version full agreement at cap=1, weight-shift produces different
  winner with agreementRate < 1, kind mismatch yields zero replayed).
- **Notes for future phases:**
  - `retrainBroad` reads ratings unconditionally from the global pool
    (it learns the user's CURRENT taste) — Constraint #3 only governs
    eval attribution, not training-set selection. Phase 6's daily cron
    calls `retrainBroad(db)` directly; the Console "Retrain now" button
    in Phase 7 wraps the same entrypoint.
  - `counterfactualReplay` re-runs the ranker top-1-per-event; the
    surfacing pipeline is top-K. The same-version sanity test pins
    `dailyCap=1` on purpose — at higher caps, replay-vs-pipeline rank-
    vs-pick gap is inherent (the Analyzer screen will model both views).
  - Refill replay rebuilds the keep set from the bucket's CURRENT members
    (we don't snapshot membership at surface time). That drift is
    accepted — the question replay answers is "what would the new
    ranker do TODAY against this pool", not "what would it have done at
    the original surface moment."
  - `evaluateBucketRecommendations` is currently called manually
    (admin trigger). Phase 6 will likely fan it out from the daily
    cron alongside retrain.

## Phase 6 — Mastra

- **Status:** review
- **Branch:** `phase-6-mastra`
- **PR:** https://github.com/hanscl/crate-digger/pull/8
- **Scope landed:** Mastra wiring on top of the deterministic core.
  `@mastra/core` 1.31 + `mastra` 1.7 CLI + `@ai-sdk/anthropic` 3 +
  `node-cron` 4. Three agents (`src/mastra/agents/{bucket-namer,
why-surfaced, playlist-parser}.ts`) on `anthropic/claude-haiku-4-5`
  with structured Zod output and a deterministic local fallback for the
  no-key / network-error case — bucket naming never blocks bucketing,
  why-surfaced always has copy, playlist parser falls back to a regex
  extractor. Daily workflow (`src/mastra/workflows/daily-pipeline.ts`)
  composed of five `createStep` calls (`pull-and-enrich`,
  `bucket-and-name`, `retrain-broad`, `recommendations`, `surface`),
  threaded as a Zod accumulator through `.then(...)` so each step both
  consumes and emits the same shape. Pure step bodies live in
  `src/mastra/lib/pipeline-steps.ts` (testable without Mastra in the
  loop). Per-run dependencies (`db`, `env`) flow through Mastra
  `RequestContext` via `src/mastra/runtime.ts` (no module-state
  globals). `src/mastra/index.ts` registers all agents + the workflow
  on a single `Mastra` instance with a `ConsoleLogger`. In-process
  `node-cron` (`src/server/cron.ts`) schedules `daily-pipeline` at
  03:00 server-local plus a 6-hour keepalive heartbeat; both can be
  disabled via `CRON_DISABLED=1` (test + reduced-env path) without
  losing the manual `runDailyPipelineNow()` entrypoint that Phase 7's
  Console "Run now" button will call. `src/server/index.ts` boots
  cron on startup and stops it on SIGTERM/SIGINT. `pnpm dev` now runs
  three concurrent processes (api, web, mastra) so `mastra dev` Studio
  is available at `localhost:4111`. `.env.example` documents the new
  `CRON_DISABLED` toggle.
  Tests (12 new, 124 total green): `tests/mastra/agents.test.ts`
  (8 cases — fallback names, null-genre placeholder, refill /
  broad-explore explanations, hyphen / "by" / blank-line / empty
  parser inputs); `tests/mastra/daily-pipeline.test.ts` (2 cases — a
  step-by-step run with a fixture adapter pulling 3 RawCandidates
  through pull → enrich → bucket → retrain → recommend → surface and
  asserting every surface_event row carries the FULL candidate pool
  (Constraint #2), plus a Mastra-orchestration smoke that runs the
  workflow via `mastra.getWorkflow('dailyPipeline').createRun().start()`
  and asserts the typed accumulator schema is fully populated even
  with zero candidates).
- **Notes for future phases:**
  - Mastra 1.31 renamed `runtimeContext` → `requestContext`; step
    `execute` callbacks read deps via `getDb(rc) / getEnv(rc)` from
    `src/mastra/runtime.ts`. The cast at the cron entry point is the
    only place we re-cross the typed/opaque boundary.
  - The orchestration smoke runs the workflow with the production
    adapter registry (`createDefaultRegistry().available(env)`); with
    a fixture env that exposes no API keys, no adapters are available
    and the pull step's `pulledCount` is 0. Phase 7 (or any future
    test that wants the workflow to pull fixture data) should plumb
    a fixture-adapter override through `requestContext` rather than
    monkey-patching the registry.
  - Agents currently fall back to deterministic placeholders when
    `ANTHROPIC_API_KEY` is unset. The structured-output schemas
    (`NAME_SCHEMA`, `EXPLANATION_SCHEMA`, `PARSE_SCHEMA`) are the
    contracts Phase 7's tRPC routers should validate against when
    surfacing agent output to the UI.
  - `node-cron` schedule is per-server-process; horizontal scale (Tier 3
    Fly multi-instance) would double-fire the daily run. Single-VM
    deploys are unaffected; the README in Phase 8 should call this out.

## Phase 7 — Frontend screens

- **Status:** review
- **Branch:** `phase-7-frontend`
- **PR:** https://github.com/hanscl/crate-digger/pull/9
- **Scope landed:** all 6 screens wired against tRPC and the deterministic
  core. tRPC app router gains `queue`, `buckets`, `evals`, `params`,
  `pipeline`, `sources`, `setup`, `taste` routers (plus the existing `me` /
  `ping`). Shared SVG primitives live in
  `src/web/components/primitives/{knob,fader,led-meter,radar,scope,
time-series,album-art,source-pill,feature-bar}.tsx` — pure React, no chart
  deps. Login screen + auth-aware shell gates every screen behind the
  cookie-auth `me` check; `LoginScreen` posts to `/api/auth/login` and the
  rest of the app boots once `me.authenticated` flips. Queue (#01) walks
  oldest-first unrated `surface_event` rows, exposes J/K/L keyboard rates,
  pulls why-surfaced text from the agent (deterministic fallback when
  `ANTHROPIC_API_KEY` is unset). Buckets (#02) renders a list+detail layout
  with rename, recommendation accept/dismiss, recompute trigger, and a
  centroid radar. Analyzer (#03) shows keep-rate/P@10/P@25/genre-entropy
  KPIs, a daily keep-rate spark, bucket purity column, and a
  counterfactual-replay table that re-ranks historical pools under any
  selected broad version (Constraint #2 payoff). Console (#04) commits
  knob+fader changes to `app_config` and bumps the refill `model_version`
  whenever lambda actually changes (Constraint #3); "Run pipeline now" /
  "Retrain broad classifier" buttons fan out to `pipeline.runNow`
  (Mastra `dailyPipeline`) and `pipeline.retrainNow` (`retrainBroad`).
  Sources (#05) lists every registered adapter with availability + enabled
  state, lets the user toggle `app_config.sources_enabled` and run a one-off
  `testFetch` (logged as a `search_run` row). Setup (#06) reports config
  health + counts, runs the cold-start playlist seeder
  (`seedBucketsFromSpotifyPlaylist`), and provides taste profile
  export/import — Constraint #8: `src/lib/taste/{schema,export,import}.ts`
  serialise buckets + ratings (centroids recomputed on import, ratings
  attribute to active broad version via the cold-start path), with a
  testcontainers round-trip test pinning the contract.
  Tests: 3 new in `tests/taste/round-trip.test.ts` (full round-trip through
  JSON wipe-and-restore, Zod boundary rejection, ISRC-match-not-duplicate
  guard); 115 lib/agent tests still green via the non-Docker subset
  (`embedding`, `centroid`, `schema`, `mastra/agents`, `ranking/refill`,
  `ranking/broad`, `ingestion/adapter-contract` = 70 tests). The 8
  Docker-only test files unchanged.
- **Notes for future phases:**
  - Mastra Studio sidecar runs as a separate `pnpm dev:mastra` process
    (`localhost:4111`); the Console screen links there directly. Phase 8
    needs to decide whether to ship Studio in the production Docker image
    (recommend off-by-default, behind same auth as the SPA).
  - The Buckets screen accepts merge recommendations via
    `buckets.accept` (folds member B into A, rebuilds centroid). Splits are
    emitted by the heuristic but NOT auto-applied — a richer interactive
    splitter is left for a follow-up; the MVP surfaces split as an
    actionable "this bucket is impure" signal only.
  - `taste.import` blocks duplicate buckets via no schema constraint; if
    the user re-imports the same export, ratings are duplicated (every
    rating row is unique by id). Encourage wiping before re-import.
  - `queue.next` returns winner-only sub-scores, not the full pool — the
    Queue screen's Scope viz currently shows just the winner. Adding the
    full pool to that response is a one-liner if the demo wants the
    distribution visible.
  - `sources.testFetch` mode inference is naive (splits the search query
    on " — " when mode=similar). Good enough for a smoke test; the daily
    pipeline does not use this path.

## Phase 8 — Deploy

- **Status:** merged
- **Branch:** `phase-8-deploy`
- **PR:** https://github.com/hanscl/crate-digger/pull/10 (merged as `1c28dbd`)
- **Scope landed:** Tier 3 cloud deploy. `fly.toml` at repo root — 512 MB
  shared-cpu-1x machine, `release_command = "pnpm db:migrate"` so migrations
  gate every rollout, `/api/health` http check, force_https, rolling strategy.
  Terraform module at `infrastructure/terraform/fly/` (versions, variables,
  main, outputs, tfvars example, module README, .gitignore for state) using
  the `fly-apps/fly` provider; provisions `fly_app` + IPv6 + shared IPv4 +
  `fly_app_secret` for every secret, with empty-value filtering so unset
  optional API keys don't shadow `optional().default("")` in
  `src/server/env.ts`. Module deliberately leaves machines to `flyctl deploy`
  and Postgres to the user (Constraint #10) — README documents the four
  supported paths (Fly Postgres, Neon, Supabase, RDS) with connection-string
  formats and SSL notes. GitHub Actions deploy workflow
  (`.github/workflows/deploy.yml`): `wait-for-ci` job blocks on the existing
  `check` job, then staging deploys on push to `main` and production deploys
  on `v*` tags, each gated by a GitHub Environment (`staging` /
  `production`) so reviewers can be required in repo settings without code
  changes. CI workflow extended to run on `v*` tags so the deploy gate has
  something to wait for. Root `README.md` rewritten with three-tier deploy
  walkthrough, DB swap matrix, and CI/CD section.
- **Notes for future phases:**
  - The `fly-apps/fly` Terraform provider is community-maintained; if it
    drifts, the entire module's responsibility (app + IPs + secrets) maps
    directly onto a few `flyctl` commands documented in the module README.
  - `node-cron` runs in-process per-machine. Single-machine deploys (the
    default in `fly.toml`, `min_machines_running = 1`) are unaffected;
    horizontal scale would double-fire the daily run — solve by extracting
    cron to a separate `processes.cron = "..."` machine with
    `min_machines_running = 1` and the app machines set to 0 cron processes,
    or by introducing a Postgres advisory-lock guard around
    `runDailyPipelineNow()`.
  - Production environment uses `auto_stop_machines = "off"` so the cron
    keeps firing during quiet periods; `auto_start_machines = true` still
    handles cold-start traffic. Flip `cron_disabled = true` on staging via
    the terraform var to keep the staging machine from racing prod against
    upstream APIs.
  - Mastra Studio (`pnpm dev:mastra`, port 4111) is a development-only
    sidecar — it is not part of the production Dockerfile or `fly.toml`.
    Re-introducing it on Fly would require a second process behind the same
    cookie auth.
