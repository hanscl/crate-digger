import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "@/db/schema";
import {
  AUDIO_FEATURE_DIM,
  audioFeaturesToVector,
  buildEmbedding,
  cosine,
  derivePrimaryGenre,
  GENRE_DIM,
  GENRE_SLOTS,
  genresToHotVector,
  normalizeTempo,
} from "@/lib/embedding";

describe("embedding — dimensions", () => {
  it("audio + genre dims add up to the schema's vector size", () => {
    expect(AUDIO_FEATURE_DIM + GENRE_DIM).toBe(EMBEDDING_DIM);
    expect(GENRE_SLOTS).toHaveLength(GENRE_DIM);
  });

  it("buildEmbedding returns a 64-d vector", () => {
    const v = buildEmbedding({ audioFeatures: null, genres: [] });
    expect(v).toHaveLength(EMBEDDING_DIM);
  });
});

describe("embedding — audio features", () => {
  it("null audio features fill the audio segment with the neutral midpoint", () => {
    const v = audioFeaturesToVector(null);
    expect(v).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it("tempo is z-scored against the prior and squashed to (0,1)", () => {
    expect(normalizeTempo(120)).toBeCloseTo(0.5);
    expect(normalizeTempo(0)).toBeLessThan(0.05);
    expect(normalizeTempo(300)).toBeGreaterThan(0.95);
  });

  it("clamps out-of-range bounded features to [0,1]", () => {
    const v = audioFeaturesToVector({
      tempo: 120,
      energy: 1.5,
      valence: -0.2,
      danceability: 0.7,
      acousticness: 0.3,
      instrumentalness: 0.1,
    });
    expect(v[1]).toBe(1);
    expect(v[2]).toBe(0);
  });
});

describe("embedding — genre multi-hot", () => {
  it("matches single-token slots", () => {
    const v = genresToHotVector(["rock"]);
    const idx = GENRE_SLOTS.indexOf("rock");
    expect(v[idx]).toBe(1);
  });

  it("sets multiple slots when a tag combines genres", () => {
    const v = genresToHotVector(["indie rock"]);
    expect(v[GENRE_SLOTS.indexOf("rock")]).toBe(1);
    expect(v[GENRE_SLOTS.indexOf("indie")]).toBe(1);
  });

  it("matches multi-token slots via contiguous-token subsequence", () => {
    const v = genresToHotVector(["post-rock"]);
    expect(v[GENRE_SLOTS.indexOf("post-rock")]).toBe(1);
    // "post-rock" should also light "rock" — the literal token "rock" is present.
    expect(v[GENRE_SLOTS.indexOf("rock")]).toBe(1);
  });

  it("matches alias keywords (dnb → drum-and-bass)", () => {
    const v = genresToHotVector(["dnb"]);
    expect(v[GENRE_SLOTS.indexOf("drum-and-bass")]).toBe(1);
  });

  it("returns the zero vector for empty input", () => {
    const v = genresToHotVector([]);
    expect(v).toEqual(Array.from({ length: GENRE_DIM }, () => 0));
  });
});

describe("embedding — derivePrimaryGenre", () => {
  it("returns null for empty genres", () => {
    expect(derivePrimaryGenre([])).toBeNull();
  });

  it("prefers the most specific (longest-keyword) slot match", () => {
    expect(derivePrimaryGenre(["post-rock"])).toBe("post-rock");
    expect(derivePrimaryGenre(["synth pop"])).toBe("synth-pop");
  });

  it("falls back to a normalized raw genre when no slot matches", () => {
    expect(derivePrimaryGenre(["completely made up genre"])).toBe("completely made up genre");
  });

  it("returns null when input is whitespace-only", () => {
    expect(derivePrimaryGenre(["   "])).toBeNull();
  });
});

describe("embedding — cosine", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 0, 0];
    expect(cosine(v, v)).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 when either side is the zero vector", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("throws on dim mismatch", () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow();
  });
});
