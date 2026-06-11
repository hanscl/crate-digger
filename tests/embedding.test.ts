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
  genreSlotsFromVector,
  genresToHotVector,
  hasSlotOverlap,
  normalizeTempo,
  weightedCosine,
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

  it("sets multiple slots when a tag combines independent genres", () => {
    // "punk rock" is a genuine rock subgenre (no cross-family qualifier), so
    // it lights both the rock-family slot and the punk slot.
    const v = genresToHotVector(["punk rock"]);
    expect(v[GENRE_SLOTS.indexOf("rock")]).toBe(1);
    expect(v[GENRE_SLOTS.indexOf("punk")]).toBe(1);
  });

  it("matches multi-token slots via contiguous-token subsequence", () => {
    const v = genresToHotVector(["post-rock"]);
    expect(v[GENRE_SLOTS.indexOf("post-rock")]).toBe(1);
    // "post-rock" should also light "rock" — the literal token "rock" is
    // present and "post" is not a cross-family qualifier.
    expect(v[GENRE_SLOTS.indexOf("rock")]).toBe(1);
  });

  it("LAB-47: pop/indie qualifiers do NOT bleed into the bare rock slot", () => {
    const rock = GENRE_SLOTS.indexOf("rock");
    const pop = GENRE_SLOTS.indexOf("pop");
    const indie = GENRE_SLOTS.indexOf("indie");

    // "pop rock" routes to pop, NOT to the metal/hard-rock-shared rock slot.
    const popRock = genresToHotVector(["pop rock"]);
    expect(popRock[rock]).toBe(0);
    expect(popRock[pop]).toBe(1);

    // "indie rock" routes to indie, not rock.
    const indieRock = genresToHotVector(["indie rock"]);
    expect(indieRock[rock]).toBe(0);
    expect(indieRock[indie]).toBe(1);

    // "indie pop rock" lights indie + pop, never the bare rock slot.
    const indiePopRock = genresToHotVector(["indie pop rock"]);
    expect(indiePopRock[rock]).toBe(0);
    expect(indiePopRock[indie]).toBe(1);
    expect(indiePopRock[pop]).toBe(1);
  });

  it("LAB-47: genuine rock-family tags still light the bare rock slot", () => {
    const rock = GENRE_SLOTS.indexOf("rock");
    for (const tag of ["rock", "hard rock", "classic rock", "punk rock", "rock & roll"]) {
      expect(genresToHotVector([tag])[rock], `${tag} should light rock`).toBe(1);
    }
  });

  it("LAB-47: the block is per-tag — a bare 'rock' tag still lights rock alongside 'pop rock'", () => {
    // A track tagged BOTH "pop rock" and bare "rock" is still rock: the
    // suppression only applies to the qualified tag, not the whole track.
    const v = genresToHotVector(["pop rock", "rock"]);
    expect(v[GENRE_SLOTS.indexOf("rock")]).toBe(1);
    expect(v[GENRE_SLOTS.indexOf("pop")]).toBe(1);
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

describe("embedding — weightedCosine (LAB-36)", () => {
  it("audioWeight=1 reduces EXACTLY to cosine (bit-identical, not approximately)", () => {
    const a = buildEmbedding({
      audioFeatures: {
        tempo: 137,
        energy: 0.83,
        valence: 0.21,
        danceability: 0.64,
        acousticness: 0.07,
        instrumentalness: 0.45,
      },
      genres: ["indie rock", "shoegaze"],
    });
    const b = buildEmbedding({
      audioFeatures: {
        tempo: 92,
        energy: 0.31,
        valence: 0.77,
        danceability: 0.4,
        acousticness: 0.88,
        instrumentalness: 0.02,
      },
      genres: ["folk", "rock"],
    });
    expect(weightedCosine(a, b, 1)).toBe(cosine(a, b));
  });

  it("scales only the audio dims: identical-audio pairs gain, identical-genre pairs lose", () => {
    const audio = audioFeaturesToVector({
      tempo: 120,
      energy: 0.8,
      valence: 0.4,
      danceability: 0.6,
      acousticness: 0.2,
      instrumentalness: 0.1,
    });
    const sameAudioDiffGenre = [
      [...audio, ...genresToHotVector(["jazz"])],
      [...audio, ...genresToHotVector(["classical"])],
    ] as const;
    expect(weightedCosine(sameAudioDiffGenre[0], sameAudioDiffGenre[1], 3)).toBeGreaterThan(
      cosine(sameAudioDiffGenre[0], sameAudioDiffGenre[1]),
    );

    const otherAudio = audioFeaturesToVector({
      tempo: 60,
      energy: 0.1,
      valence: 0.9,
      danceability: 0.2,
      acousticness: 0.95,
      instrumentalness: 0.8,
    });
    const diffAudioSameGenre = [
      [...audio, ...genresToHotVector(["rock"])],
      [...otherAudio, ...genresToHotVector(["rock"])],
    ] as const;
    expect(weightedCosine(diffAudioSameGenre[0], diffAudioSameGenre[1], 3)).toBeLessThan(
      cosine(diffAudioSameGenre[0], diffAudioSameGenre[1]),
    );
  });

  it("throws on dim mismatch", () => {
    expect(() => weightedCosine([1, 2], [1, 2, 3], 2)).toThrow();
  });
});

describe("embedding — genre slot helpers (LAB-36)", () => {
  it("genreSlotsFromVector recovers a track's multi-hot slots from the full embedding", () => {
    // "punk rock" lights two independent slots (rock-family + punk).
    const embedding = buildEmbedding({ audioFeatures: null, genres: ["punk rock"] });
    const slots = genreSlotsFromVector(embedding);
    expect(slots.has(GENRE_SLOTS.indexOf("rock"))).toBe(true);
    expect(slots.has(GENRE_SLOTS.indexOf("punk"))).toBe(true);
    expect(slots.size).toBe(2);
  });

  it("centroid genre MASS counts: one member out of N keeps the slot on (> epsilon)", () => {
    // Simulated 4-member centroid where a single member contributed "jazz":
    // mass 0.25 — still on. The neutral 0.5 audio fills never read as slots.
    const centroid = [
      ...audioFeaturesToVector(null),
      ...genresToHotVector(["jazz"]).map((x) => x / 4),
    ];
    const slots = genreSlotsFromVector(centroid);
    expect(slots.has(GENRE_SLOTS.indexOf("jazz"))).toBe(true);
    expect(slots.size).toBe(1);
  });

  it("zero-genre embeddings yield the empty set; hasSlotOverlap demands a shared slot", () => {
    const none = genreSlotsFromVector(buildEmbedding({ audioFeatures: null, genres: [] }));
    expect(none.size).toBe(0);
    const rock = genreSlotsFromVector(buildEmbedding({ audioFeatures: null, genres: ["rock"] }));
    // LAB-47 — "indie rock" no longer shares the bare rock slot; "punk rock"
    // (a true rock subgenre) still does.
    const indieRock = genreSlotsFromVector(
      buildEmbedding({ audioFeatures: null, genres: ["indie rock"] }),
    );
    const punkRock = genreSlotsFromVector(
      buildEmbedding({ audioFeatures: null, genres: ["punk rock"] }),
    );
    const jazz = genreSlotsFromVector(buildEmbedding({ audioFeatures: null, genres: ["jazz"] }));
    expect(hasSlotOverlap(rock, indieRock)).toBe(false);
    expect(hasSlotOverlap(rock, punkRock)).toBe(true);
    expect(hasSlotOverlap(rock, jazz)).toBe(false);
    expect(hasSlotOverlap(rock, none)).toBe(false);
  });
});
