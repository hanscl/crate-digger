import { GENRE_SLOTS } from "@/lib/embedding";

/**
 * LAB-40 — how many "new direction" genres the explore pull rotates through per
 * run. Small by design: explore is the minority of the daily pull (the
 * taste-seeded similar/trending pools are the majority), and each genre costs an
 * extra upstream call per explore-capable source.
 */
export const EXPLORE_GENRES_PER_RUN = 3;

/**
 * LAB-40 — pick the next batch of genres to explore: genre slots NOT represented
 * in the user's buckets, so the pull reaches OUTSIDE current taste. Walks the
 * stable {@link GENRE_SLOTS} vocabulary starting at `cursor` (wrapping) and
 * collects up to `k` unrepresented slots, returning their names plus the
 * advanced cursor (the LAB-38 refill-cursor pattern, applied to genres) so
 * consecutive runs rotate across the whole vocabulary instead of re-pulling the
 * same first-k every day.
 *
 * Pure — the caller owns the DB read (represented slots) and the cursor persist.
 * `representedSlots` holds 0-based GENRE_SLOTS indices (as {@link genreSlotsFromVector}
 * yields). On cold start (no buckets) nothing is represented, so the batch is the
 * first `k` of the rotation. When every slot is already represented the batch is
 * empty — there is nothing "outside" the user's taste to reach for.
 */
export function selectExploreGenres(
  representedSlots: ReadonlySet<number>,
  cursor: number,
  k: number,
): { genres: string[]; nextCursor: number } {
  const n = GENRE_SLOTS.length;
  if (k <= 0 || n === 0 || representedSlots.size >= n) {
    return { genres: [], nextCursor: cursor };
  }
  // Normalize the cursor into [0, n) so a persisted/overflowed value still maps
  // to a valid start slot.
  const start = ((Math.trunc(cursor) % n) + n) % n;
  let idx = start;
  let scanned = 0;
  const genres: string[] = [];
  // One pass over the vocabulary at most; stop early once k are collected.
  for (; scanned < n && genres.length < k; scanned++) {
    if (!representedSlots.has(idx)) genres.push(GENRE_SLOTS[idx]!);
    idx = (idx + 1) % n;
  }
  // Normal case (filled the batch before a full lap): `idx` points just past the
  // last slot taken, so the next run resumes there and coverage rotates. Full-lap
  // case (fewer than k slots are unrepresented, so this batch already IS the
  // entire out-of-taste set): `idx` has wrapped back to `start` — nudge it one
  // slot so the cursor still advances run-over-run instead of pinning in place
  // (the batch is the same complete set either way).
  const nextCursor = scanned >= n ? (start + 1) % n : idx;
  return { genres, nextCursor };
}
