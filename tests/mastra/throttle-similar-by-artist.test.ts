import { describe, expect, it } from "vitest";
import type { RawCandidate } from "@/lib/ingestion";
import { throttleSimilarByArtist } from "@/mastra/lib/pipeline-steps";

/**
 * LAB-73 lever 1 — the pure per-artist throttle for the similar pull. No DB:
 * the caller owns the keep-count read, this function is just the filter.
 */

function cand(artist: string, title = artist): RawCandidate {
  return {
    source: "lastfm",
    sourceTrackId: `${artist}::${title}`,
    isrc: null,
    spotifyId: null,
    title,
    artist,
    album: null,
    releaseYear: null,
    durationMs: null,
    popularity: null,
    genres: [],
    rawPayload: null,
  };
}

const NO_KEEPS = new Map<string, number>();

describe("throttleSimilarByArtist (LAB-73 lever 1)", () => {
  it("caps at N tracks per artist within a single batch", () => {
    const cands = [cand("A", "a1"), cand("A", "a2"), cand("A", "a3"), cand("B", "b1")];
    const r = throttleSimilarByArtist(cands, {
      cap: 2,
      keepThreshold: 0,
      keepCounts: NO_KEEPS,
      running: new Map(),
    });
    expect(r.kept.map((c) => c.title)).toEqual(["a1", "a2", "b1"]);
    expect(r.cappedCount).toBe(1);
    expect(r.skippedCount).toBe(0);
  });

  it("accumulates the per-artist cap ACROSS batches via the shared running map", () => {
    const running = new Map<string, number>();
    const opts = { cap: 2, keepThreshold: 0, keepCounts: NO_KEEPS, running };
    const first = throttleSimilarByArtist([cand("A", "a1"), cand("A", "a2")], opts);
    const second = throttleSimilarByArtist([cand("A", "a3"), cand("B", "b1")], opts);
    expect(first.kept.map((c) => c.title)).toEqual(["a1", "a2"]);
    // A is already at the cap from the first batch → a3 is dropped.
    expect(second.kept.map((c) => c.title)).toEqual(["b1"]);
    expect(second.cappedCount).toBe(1);
  });

  it("skips artists already represented by >= keepThreshold keeps", () => {
    const keepCounts = new Map([["a", 3]]);
    const r = throttleSimilarByArtist([cand("A"), cand("B")], {
      cap: 5,
      keepThreshold: 3,
      keepCounts,
      running: new Map(),
    });
    expect(r.kept.map((c) => c.artist)).toEqual(["B"]);
    expect(r.skippedCount).toBe(1);
    expect(r.cappedCount).toBe(0);
  });

  it("keepThreshold = 0 disables the familiar-artist skip", () => {
    const keepCounts = new Map([["a", 99]]);
    const r = throttleSimilarByArtist([cand("A")], {
      cap: 5,
      keepThreshold: 0,
      keepCounts,
      running: new Map(),
    });
    expect(r.kept).toHaveLength(1);
    expect(r.skippedCount).toBe(0);
  });

  it("counts a familiar over-cap artist as skipped, not capped (skip is checked first)", () => {
    const keepCounts = new Map([["a", 3]]);
    const r = throttleSimilarByArtist([cand("A", "a1"), cand("A", "a2")], {
      cap: 1,
      keepThreshold: 3,
      keepCounts,
      running: new Map(),
    });
    expect(r.kept).toHaveLength(0);
    expect(r.skippedCount).toBe(2);
    expect(r.cappedCount).toBe(0);
  });

  it("normalizes artist keys (case/whitespace) for both the cap and the keep-skip", () => {
    const keepCounts = new Map([["the killers", 3]]);
    const r = throttleSimilarByArtist([cand("THE KILLERS"), cand("  the killers  ")], {
      cap: 5,
      keepThreshold: 3,
      keepCounts,
      running: new Map(),
    });
    expect(r.kept).toHaveLength(0);
    expect(r.skippedCount).toBe(2);
  });

  it("keeps candidates with a blank artist (they bypass the throttle)", () => {
    const r = throttleSimilarByArtist([cand("", "x"), cand("", "y")], {
      cap: 1,
      keepThreshold: 1,
      keepCounts: NO_KEEPS,
      running: new Map(),
    });
    expect(r.kept).toHaveLength(2);
    expect(r.cappedCount).toBe(0);
    expect(r.skippedCount).toBe(0);
  });

  it("cap <= 0 disables the per-artist cap (unlimited)", () => {
    const r = throttleSimilarByArtist([cand("A", "a1"), cand("A", "a2"), cand("A", "a3")], {
      cap: 0,
      keepThreshold: 0,
      keepCounts: NO_KEEPS,
      running: new Map(),
    });
    expect(r.kept).toHaveLength(3);
    expect(r.cappedCount).toBe(0);
  });
});
