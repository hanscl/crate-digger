import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  bucket,
  bucketMember,
  type CandidatePoolEntry,
  rating,
  surfaceEvent,
  type SurfaceEvent,
  track,
} from "@/db/schema";
import { sameGenreScope } from "@/lib/bucketing/genre-scope";
import { scoreBroad } from "@/lib/ranking/broad";
import { scoreRefill } from "@/lib/ranking/refill";
import type { Candidate, RatedTrack, ScoredCandidate } from "@/lib/ranking/types";
import { configFromVersion, getModelVersion } from "@/lib/ranking/version";

/**
 * Counterfactual replay. Given a target `model_version_id`, walk historical
 * `surface_event` rows and re-rank each event's persisted candidate pool
 * under the target version's config. Compare the would-have-surfaced track
 * against what was originally surfaced and report the delta.
 *
 * This is the eval substrate's payoff: the FULL candidate pool stored at
 * surface time (Constraint #2) plus the ranker's pure-function shape make
 * "what would v6 have surfaced if it had been live yesterday?" trivial to
 * compute. No ingestion replay; no re-fetching tracks; just the pool +
 * config + ranker math.
 *
 * Refill semantics: refill events are scoped to a bucket. Replay rebuilds
 * the keep set from the bucket's CURRENT members (not the original ones —
 * we don't snapshot bucket membership at surface time, since it's a moving
 * target by design). This is fine for "would v6 have done better" questions
 * and matches what the live ranker would have seen at replay time. Refill
 * events whose bucket was deleted/merged before replay (their `bucketId`
 * nulled by the FK) are SKIPPED — a bucket-scoped event with no bucket can't
 * be faithfully re-ranked, and replaying it under a null scope would corrupt
 * `agreementRate` with a deletion artifact.
 *
 * Broad semantics: broad events have no bucket scope; replay rescores each
 * pool entry under the target broad config. Embeddings come from the pool
 * itself only when an entry has them; otherwise we hydrate from `track`.
 *
 * Empty pool short-circuit: surface events whose pool is empty (synthetic
 * test rows or future migrations) are skipped without contributing to the
 * delta — they have nothing to rerank. The result lists them in
 * `skippedEventIds` so the UI can flag them.
 */

export type CounterfactualWindow = {
  start?: Date | null;
  end?: Date;
  /** Hard cap on events scanned. Default 500 — keeps replay snappy. Clamped to [1, 500]. */
  limit?: number;
};

const DEFAULT_REPLAY_LIMIT = 500;
const MAX_REPLAY_LIMIT = 500;

export type CounterfactualEventResult = {
  surfaceEventId: number;
  /** The originally surfaced track. */
  originalTrackId: number;
  originalScore: number;
  /** The track the target version would have picked from the same pool. */
  replayedTrackId: number;
  replayedScore: number;
  /** Did the target version's winner match the original? */
  agreed: boolean;
  /** All pool entries rescored under the target version, sorted highest-first. */
  replayedPool: { trackId: number; score: number; subScores: Record<string, number> }[];
};

export type CounterfactualReplayResult = {
  targetModelVersionId: number;
  targetKind: "refill" | "broad";
  scannedEventCount: number;
  replayedEventCount: number;
  /** Events whose pool was empty / pool entries unrecoverable. */
  skippedEventIds: number[];
  /** Events skipped because their kind doesn't match the target's kind. */
  kindMismatchedEventIds: number[];
  agreementCount: number;
  agreementRate: number;
  /**
   * Of replayed events, those where the user actually rated the original
   * winner. Compare keep-rate of agreed-vs-disagreed to see if the new
   * version would have improved keep-rate.
   */
  ratedEventCount: number;
  /** Events where we agreed AND the user kept. */
  agreedAndKeptCount: number;
  /** Events where we disagreed AND the user disliked the original. */
  disagreedAndDislikedCount: number;
  /** Per-event detail. Always populated; UI may paginate client-side. */
  perEvent: CounterfactualEventResult[];
};

export async function counterfactualReplay(
  db: Database,
  targetVersionId: number,
  window: CounterfactualWindow = {},
): Promise<CounterfactualReplayResult> {
  const versionRow = await getModelVersion(db, targetVersionId);
  if (!versionRow) {
    throw new Error(`counterfactualReplay: model_version id=${targetVersionId} not found`);
  }
  const targetKind = versionRow.kind;
  const config =
    targetKind === "refill"
      ? configFromVersion(versionRow, "refill")
      : configFromVersion(versionRow, "broad");

  // We deliberately do NOT prefilter by ranker_kind in SQL. The in-loop
  // mismatch path classifies events into `kindMismatchedEventIds` so the
  // caller can see how much of the scan was outside the target's kind. A
  // SQL prefilter would render that field permanently empty.
  const conds = [];
  if (window.start) conds.push(gte(surfaceEvent.surfacedAt, window.start));
  if (window.end) conds.push(lte(surfaceEvent.surfacedAt, window.end));
  const requestedLimit =
    typeof window.limit === "number" && Number.isFinite(window.limit)
      ? Math.floor(window.limit)
      : DEFAULT_REPLAY_LIMIT;
  const limit = Math.max(1, Math.min(MAX_REPLAY_LIMIT, requestedLimit));

  // Stable order: newest-first by surfacedAt, then id, so the LIMIT yields a
  // deterministic subset across replays.
  const events = await db
    .select()
    .from(surfaceEvent)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(surfaceEvent.surfacedAt), desc(surfaceEvent.id))
    .limit(limit);

  // Collect every track id referenced by any event's pool. One bulk fetch
  // beats N+1 queries when the user is replaying months of history.
  const trackIdsToHydrate = new Set<number>();
  for (const event of events) {
    for (const entry of event.candidatePool) trackIdsToHydrate.add(entry.trackId);
  }
  const hydratedTracks =
    trackIdsToHydrate.size === 0
      ? []
      : await db
          .select({
            id: track.id,
            embedding: track.embedding,
            primaryGenre: track.primaryGenre,
            audioFeatures: track.audioFeatures,
          })
          .from(track)
          .where(inArray(track.id, [...trackIdsToHydrate]));
  const trackById = new Map(hydratedTracks.map((t) => [t.id, t]));

  // Refill replay needs bucket-keep embeddings; pull them all up front for
  // every bucket referenced by a refill event in the window.
  const refillBucketIds = new Set<number>();
  for (const event of events) {
    if (event.rankerKind === "refill" && event.bucketId !== null) {
      refillBucketIds.add(event.bucketId);
    }
  }
  const keepsByBucket = await loadKeepsByBucket(db, [...refillBucketIds]);
  // Sibling lookup: the bucket's primary genre keyed by id, so the refill
  // winner pick can apply the same same-genre eligibility gate the live
  // surfacing pipeline uses (assign.ts is the canonical JOIN gate).
  const genreByBucket = await loadGenreByBucket(db, [...refillBucketIds]);

  // Dislikes for refill scoring use whatever the user has currently rated
  // 'dislike'. The original surface time may have seen a different dislike
  // set; that drift is ACCEPTED — we're answering "what would the new ranker
  // do TODAY against this pool" rather than reconstructing past state.
  const dislikes = targetKind === "refill" ? await loadGlobalDislikes(db) : [];

  const eventRatings = await loadEventRatings(
    db,
    events.map((e) => e.id),
  );

  const skippedEventIds: number[] = [];
  const kindMismatchedEventIds: number[] = [];
  const perEvent: CounterfactualEventResult[] = [];
  let agreementCount = 0;
  let ratedEventCount = 0;
  let agreedAndKeptCount = 0;
  let disagreedAndDislikedCount = 0;

  for (const event of events) {
    if (event.rankerKind !== targetKind) {
      kindMismatchedEventIds.push(event.id);
      continue;
    }
    if (event.candidatePool.length === 0) {
      skippedEventIds.push(event.id);
      continue;
    }

    // A refill event whose bucket was deleted/merged between surface and replay
    // has its `bucketId` nulled by the FK (surface_event.bucket_id ON DELETE SET
    // NULL); refill events are always written with a non-null bucketId, so a
    // null one is exclusively a deletion artifact. With the bucket gone, the
    // genre gate and keep-set can't be faithfully reconstructed: replaying under
    // a null scope would let a null-genre candidate win a slot the original
    // genre bucket required (or skip only genre-having pools) — contaminating
    // agreementRate with a data-deletion artifact rather than a ranker
    // comparison. Skip uniformly, same honesty as the empty-pool short-circuit.
    // (A live bucket whose primaryGenre is null keeps a non-null id and replays
    // normally under the valid null===null scope.)
    if (targetKind === "refill" && event.bucketId === null) {
      skippedEventIds.push(event.id);
      continue;
    }

    const candidates = poolToCandidates(event.candidatePool, trackById);
    if (candidates.length === 0) {
      skippedEventIds.push(event.id);
      continue;
    }

    let scored: ScoredCandidate[];
    if (targetKind === "broad") {
      scored = candidates.map((c) =>
        scoreBroad(c, config as ReturnType<typeof configFromVersion<"broad">>),
      );
    } else {
      const keeps = event.bucketId !== null ? (keepsByBucket.get(event.bucketId) ?? []) : [];
      scored = candidates.map((c) =>
        scoreRefill(c, keeps, dislikes, config as ReturnType<typeof configFromVersion<"refill">>),
      );
    }

    // Tie-break by trackId (matches surfacing pipeline) so replay is
    // deterministic given identical scores.
    scored.sort((a, b) => b.score - a.score || a.candidate.trackId - b.candidate.trackId);
    // Refill winner selection mirrors the live pipeline's primary-genre
    // eligibility gate (assign.ts is the canonical JOIN gate): only a
    // same-genre candidate can win the slot. Off-genre candidates stay in
    // `scored`/`replayedPool` (Constraint #2) but are never the replay winner.
    // Broad events have no bucket scope, so every candidate is eligible.
    const eligible =
      targetKind === "refill"
        ? scored.filter((s) =>
            sameGenreScope(
              s.candidate.primaryGenre,
              event.bucketId !== null ? (genreByBucket.get(event.bucketId) ?? null) : null,
            ),
          )
        : scored;
    const winner = eligible[0];
    if (!winner) {
      skippedEventIds.push(event.id);
      continue;
    }

    const replayedTrackId = winner.candidate.trackId;
    const agreed = replayedTrackId === event.trackId;
    if (agreed) agreementCount += 1;

    const ratingDecision = eventRatings.get(event.id);
    if (ratingDecision === "keep" || ratingDecision === "dislike") {
      ratedEventCount += 1;
      if (agreed && ratingDecision === "keep") agreedAndKeptCount += 1;
      if (!agreed && ratingDecision === "dislike") disagreedAndDislikedCount += 1;
    }

    perEvent.push({
      surfaceEventId: event.id,
      originalTrackId: event.trackId,
      originalScore: event.winnerScore,
      replayedTrackId,
      replayedScore: winner.score,
      agreed,
      replayedPool: scored.map((s) => ({
        trackId: s.candidate.trackId,
        score: s.score,
        subScores: s.subScores,
      })),
    });
  }

  const replayedEventCount = perEvent.length;
  return {
    targetModelVersionId: targetVersionId,
    targetKind,
    scannedEventCount: events.length,
    replayedEventCount,
    skippedEventIds,
    kindMismatchedEventIds,
    agreementCount,
    agreementRate: replayedEventCount === 0 ? 0 : agreementCount / replayedEventCount,
    ratedEventCount,
    agreedAndKeptCount,
    disagreedAndDislikedCount,
    perEvent,
  };
}

function poolToCandidates(
  pool: readonly CandidatePoolEntry[],
  trackById: Map<
    number,
    {
      embedding: number[] | null;
      primaryGenre: string | null;
      audioFeatures: { tempo: number } | null;
    }
  >,
): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of pool) {
    const t = trackById.get(entry.trackId);
    if (!t || !t.embedding) continue;
    out.push({
      trackId: entry.trackId,
      embedding: t.embedding,
      primaryGenre: t.primaryGenre,
      audioFeatures: t.audioFeatures ? (t.audioFeatures as Candidate["audioFeatures"]) : null,
    });
  }
  return out;
}

async function loadKeepsByBucket(
  db: Database,
  bucketIds: readonly number[],
): Promise<Map<number, RatedTrack[]>> {
  if (bucketIds.length === 0) return new Map();
  const rows = await db
    .select({
      bucketId: bucketMember.bucketId,
      trackId: bucketMember.trackId,
      embedding: track.embedding,
    })
    .from(bucketMember)
    .innerJoin(track, eq(track.id, bucketMember.trackId))
    .where(inArray(bucketMember.bucketId, [...bucketIds]));
  const out = new Map<number, RatedTrack[]>();
  for (const r of rows) {
    if (r.embedding === null) continue;
    const list = out.get(r.bucketId) ?? [];
    list.push({ trackId: r.trackId, embedding: r.embedding });
    out.set(r.bucketId, list);
  }
  return out;
}

/**
 * Primary genre keyed by bucket id, for the refill replay eligibility gate.
 * Every id passed here is a refill event's non-null `bucketId`. Because
 * `surface_event.bucket_id` is an FK with ON DELETE SET NULL, a non-null
 * bucketId always references a still-live bucket — so this query returns a
 * row for every id, and a `.get()` miss never happens. (A bucket deleted or
 * merged away nulls the event's bucketId instead; the caller skips those
 * events upstream before the gate.) A live bucket whose primaryGenre is null
 * maps to null — the valid null===null scope.
 */
async function loadGenreByBucket(
  db: Database,
  bucketIds: readonly number[],
): Promise<Map<number, string | null>> {
  if (bucketIds.length === 0) return new Map();
  const rows = await db
    .select({ id: bucket.id, primaryGenre: bucket.primaryGenre })
    .from(bucket)
    .where(inArray(bucket.id, [...bucketIds]));
  return new Map(rows.map((r) => [r.id, r.primaryGenre]));
}

async function loadGlobalDislikes(db: Database): Promise<RatedTrack[]> {
  const rows = await db
    .select({ trackId: track.id, embedding: track.embedding })
    .from(rating)
    .innerJoin(track, eq(track.id, rating.trackId))
    .where(eq(rating.decision, "dislike"));
  return rows
    .filter((r): r is { trackId: number; embedding: number[] } => r.embedding !== null)
    .map((r) => ({ trackId: r.trackId, embedding: r.embedding }));
}

async function loadEventRatings(
  db: Database,
  eventIds: readonly number[],
): Promise<Map<number, "keep" | "dislike" | "defer" | "neutral">> {
  if (eventIds.length === 0) return new Map();
  // Newest-first so that re-rated events (defer → keep, etc.) deterministically
  // pick the latest decision. The first row written wins; subsequent rows for
  // the same surfaceEventId are ignored.
  const rows = await db
    .select({
      surfaceEventId: rating.surfaceEventId,
      decision: rating.decision,
    })
    .from(rating)
    .where(inArray(rating.surfaceEventId, [...eventIds]))
    .orderBy(desc(rating.ratedAt), desc(rating.id));
  const out = new Map<number, "keep" | "dislike" | "defer" | "neutral">();
  for (const r of rows) {
    if (r.surfaceEventId === null) continue;
    if (out.has(r.surfaceEventId)) continue;
    out.set(r.surfaceEventId, r.decision);
  }
  return out;
}

// Re-export for callers building eval views — `SurfaceEvent` is the natural
// row shape they already iterate.
export type { SurfaceEvent };
