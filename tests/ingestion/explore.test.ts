import { describe, expect, it } from "vitest";
import { GENRE_SLOTS } from "@/lib/embedding";
import { EXPLORE_GENRES_PER_RUN, selectExploreGenres } from "@/lib/ingestion/explore";

const N = GENRE_SLOTS.length;

describe("selectExploreGenres (LAB-40 new-direction genre selection)", () => {
  it("on cold start (no represented slots) returns the first k of the rotation", () => {
    const { genres, nextCursor } = selectExploreGenres(new Set(), 0, 3);
    expect(genres).toEqual([GENRE_SLOTS[0], GENRE_SLOTS[1], GENRE_SLOTS[2]]);
    expect(nextCursor).toBe(3);
  });

  it("skips represented slots so the batch is strictly OUTSIDE current taste", () => {
    // Represent slots 0 and 2; walking from cursor 0 must skip both.
    const { genres, nextCursor } = selectExploreGenres(new Set([0, 2]), 0, 3);
    expect(genres).toEqual([GENRE_SLOTS[1], GENRE_SLOTS[3], GENRE_SLOTS[4]]);
    // Cursor lands just past the last slot taken (index 4 → 5).
    expect(nextCursor).toBe(5);
    // None of the chosen genres maps to a represented slot.
    expect(genres).not.toContain(GENRE_SLOTS[0]);
    expect(genres).not.toContain(GENRE_SLOTS[2]);
  });

  it("rotates: resuming from the returned cursor yields the NEXT band, not a repeat", () => {
    const first = selectExploreGenres(new Set(), 0, EXPLORE_GENRES_PER_RUN);
    const second = selectExploreGenres(new Set(), first.nextCursor, EXPLORE_GENRES_PER_RUN);
    expect(second.genres).not.toEqual(first.genres);
    expect(first.genres.some((g) => second.genres.includes(g))).toBe(false);
  });

  it("wraps around the end of the vocabulary", () => {
    const { genres, nextCursor } = selectExploreGenres(new Set(), N - 1, 3);
    expect(genres).toEqual([GENRE_SLOTS[N - 1], GENRE_SLOTS[0], GENRE_SLOTS[1]]);
    expect(nextCursor).toBe(2);
  });

  it("normalizes an out-of-range / overflowed cursor into the vocabulary", () => {
    const { genres } = selectExploreGenres(new Set(), N + 1, 3);
    // N + 1 ≡ 1 (mod N).
    expect(genres).toEqual([GENRE_SLOTS[1], GENRE_SLOTS[2], GENRE_SLOTS[3]]);
  });

  it("returns an empty batch (cursor unchanged) when k <= 0", () => {
    expect(selectExploreGenres(new Set(), 7, 0)).toEqual({ genres: [], nextCursor: 7 });
  });

  it("returns an empty batch when every slot is already represented", () => {
    const all = new Set(Array.from({ length: N }, (_, i) => i));
    expect(selectExploreGenres(all, 4, 3)).toEqual({ genres: [], nextCursor: 4 });
  });

  it("collects fewer than k when only a few slots are unrepresented", () => {
    // Represent all but slot 5.
    const all = new Set(Array.from({ length: N }, (_, i) => i));
    all.delete(5);
    const { genres } = selectExploreGenres(all, 0, 3);
    expect(genres).toEqual([GENRE_SLOTS[5]]);
  });

  it("advances the cursor in the sparse case so the rotation never pins in place", () => {
    // Only one slot unrepresented and k=3: a full lap collects fewer than k, but
    // the cursor must still move forward run-over-run (not return to `start`).
    const all = new Set(Array.from({ length: N }, (_, i) => i));
    all.delete(5);
    const first = selectExploreGenres(all, 0, 3);
    expect(first.genres).toEqual([GENRE_SLOTS[5]]);
    expect(first.nextCursor).toBe(1); // advanced from start (0), not pinned at 0
    // Resuming from the advanced cursor still returns the complete out-of-taste
    // set and keeps moving — no stall.
    const second = selectExploreGenres(all, first.nextCursor, 3);
    expect(second.genres).toEqual([GENRE_SLOTS[5]]);
    expect(second.nextCursor).toBe(2);
  });
});
