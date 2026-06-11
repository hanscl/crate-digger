import { describe, expect, it } from "vitest";
import { genreScopeCompatible, sameGenreScope } from "@/lib/bucketing/genre-scope";
import { buildEmbedding } from "@/lib/embedding";

/**
 * LAB-36 — pure predicate contract for the config-selected genre gate. The
 * DB-integrated coverage lives in assign/pipeline/counterfactual tests; this
 * file pins the degenerate-case table that preserves today's lanes exactly.
 */

const emb = (genres: string[]) => buildEmbedding({ audioFeatures: null, genres });

describe("genreScopeCompatible — 'exact' (LAB-45 rule)", () => {
  it("matches identical primary genres, including null===null", () => {
    const bucket = { primaryGenre: "rock", centroid: emb(["rock"]) };
    expect(
      genreScopeCompatible("exact", { primaryGenre: "rock", embedding: emb(["rock"]) }, bucket),
    ).toBe(true);
    expect(
      genreScopeCompatible(
        "exact",
        { primaryGenre: "indie", embedding: emb(["indie rock"]) },
        bucket,
      ),
    ).toBe(false);
    expect(
      genreScopeCompatible(
        "exact",
        { primaryGenre: null, embedding: emb([]) },
        { primaryGenre: null, centroid: emb([]) },
      ),
    ).toBe(true);
  });
});

describe("genreScopeCompatible — 'slot-overlap' (LAB-36 rule)", () => {
  it("compatible iff ≥1 shared slot between track slots and bucket centroid mass", () => {
    const rockBucket = { primaryGenre: "rock", centroid: emb(["rock"]) };
    // Cross-lane: blues-primary track that genuinely shares the rock slot
    // ("blues rock" is a true rock subgenre — no cross-family qualifier — and
    // derives a blues PRIMARY because "blues" is its longest matched keyword).
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: "blues", embedding: emb(["blues rock"]) },
        rockBucket,
      ),
    ).toBe(true);
    // LAB-47 — "indie rock" no longer bleeds into the bare rock slot, so an
    // indie-primary track is NOT pulled into the rock-vs-metal lane.
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: "indie", embedding: emb(["indie rock"]) },
        rockBucket,
      ),
    ).toBe(false);
    // Disjoint slots: jazz vs rock.
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: "jazz", embedding: emb(["jazz"]) },
        rockBucket,
      ),
    ).toBe(false);
  });

  it("bucket side is centroid MASS: any member's slot counts, not just the primary", () => {
    // 2-member bucket: electronic-primary seed whose second member added
    // "rock" mass at 0.5 — a rock track is compatible despite the bucket's
    // primary genre. This is what makes the gate insert-order-insensitive.
    const centroid = emb(["electronic"]).map((x, i) => (x + (emb(["rock"])[i] ?? 0)) / 2);
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: "rock", embedding: emb(["rock"]) },
        { primaryGenre: "electronic", centroid },
      ),
    ).toBe(true);
  });

  it("zero-slot track falls back to exact primary-genre equality (today's lanes preserved)", () => {
    // Null-genre track vs null-genre bucket: compatible (null===null).
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: null, embedding: emb([]) },
        { primaryGenre: null, centroid: emb([]) },
      ),
    ).toBe(true);
    // Raw tag matching no slot: exact equality on the derived raw genre.
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: "zeuhl", embedding: emb(["zeuhl"]) },
        { primaryGenre: "zeuhl", centroid: emb(["zeuhl"]) },
      ),
    ).toBe(true);
    // Zero-slot track is NOT pulled into a slotted bucket by audio alone.
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: null, embedding: emb([]) },
        { primaryGenre: "rock", centroid: emb(["rock"]) },
      ),
    ).toBe(false);
  });

  it("a slotted track is NOT compatible with a zero-genre-mass bucket", () => {
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: "rock", embedding: emb(["rock"]) },
        { primaryGenre: null, centroid: emb([]) },
      ),
    ).toBe(false);
  });

  it("a missing embedding counts as zero slots (exact fallback)", () => {
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: "rock", embedding: null },
        { primaryGenre: "rock", centroid: emb(["rock"]) },
      ),
    ).toBe(true);
    expect(
      genreScopeCompatible(
        "slot-overlap",
        { primaryGenre: "indie", embedding: undefined },
        { primaryGenre: "rock", centroid: emb(["rock"]) },
      ),
    ).toBe(false);
  });
});

describe("sameGenreScope — exact predicate (unchanged LAB-45 helper)", () => {
  it("coerces undefined to null and compares", () => {
    expect(sameGenreScope(undefined, null)).toBe(true);
    expect(sameGenreScope("rock", "rock")).toBe(true);
    expect(sameGenreScope("rock", null)).toBe(false);
  });
});
