import { describe, expect, it } from "vitest";
import { isRenameEligible } from "@/mastra/lib/pipeline-steps";

/**
 * Unit tests for the LAB-25 rename-step eligibility rule. Pure boundary
 * pinning — no DB, no agent. The rule itself decides whether the bucket
 * even gets passed to the namer; if these cases drift we'll silently rename
 * human-chosen names or skip clusters that have visibly shifted.
 */

const DIM = 64;
const ones = (): number[] => Array.from({ length: DIM }, () => 1);
/** Mostly-similar centroid that yields cosine ≈ 0.99 vs `ones()`. */
function nearlyOnes(): number[] {
  // Cosine vs `ones()` = sum(a) / (sqrt(64) * |a|). Bumping one component
  // up keeps the vectors mostly aligned.
  const v = ones();
  v[0] = 1.1;
  return v;
}
/** Centroid that yields cosine ≈ 0.85 vs `ones()` (visibly drifted). */
function drifted(): number[] {
  const v = ones();
  // Zero out the first 16 dims to drop cosine significantly while keeping
  // both vectors non-zero.
  for (let i = 0; i < 16; i++) v[i] = 0;
  return v;
}

const PLACEHOLDER = "metal (auto)";
const HUMAN_NAME = "Late-night Drive";
const AGENT_NAME = "Acoustic Ballads";

describe("isRenameEligible", () => {
  it("is not eligible below the lazy-naming threshold", () => {
    expect(
      isRenameEligible({
        name: PLACEHOLDER,
        centroid: ones(),
        memberCount: 2,
        lastNamedAtCount: null,
        lastNamedCentroid: null,
      }),
    ).toBe(false);
  });

  it("is eligible when an (auto) placeholder first crosses N≥3", () => {
    expect(
      isRenameEligible({
        name: PLACEHOLDER,
        centroid: ones(),
        memberCount: 3,
        lastNamedAtCount: null,
        lastNamedCentroid: null,
      }),
    ).toBe(true);
  });

  it("does NOT touch human-renamed buckets (real name + last_named_at_count NULL)", () => {
    expect(
      isRenameEligible({
        name: HUMAN_NAME,
        centroid: ones(),
        memberCount: 12,
        lastNamedAtCount: null,
        lastNamedCentroid: null,
      }),
    ).toBe(false);
  });

  it("is eligible when membership doubles since the last agent naming", () => {
    expect(
      isRenameEligible({
        name: AGENT_NAME,
        centroid: ones(),
        memberCount: 4,
        lastNamedAtCount: 2,
        lastNamedCentroid: ones(),
      }),
    ).toBe(true);
  });

  it("is NOT eligible when the centroid barely moved (cosine ~0.99)", () => {
    expect(
      isRenameEligible({
        name: AGENT_NAME,
        centroid: nearlyOnes(),
        memberCount: 5,
        lastNamedAtCount: 4,
        lastNamedCentroid: ones(),
      }),
    ).toBe(false);
  });

  it("is eligible when the centroid drifted past the threshold", () => {
    expect(
      isRenameEligible({
        name: AGENT_NAME,
        centroid: drifted(),
        memberCount: 5,
        lastNamedAtCount: 4,
        lastNamedCentroid: ones(),
      }),
    ).toBe(true);
  });

  it("does NOT re-name an agent-named bucket that hasn't doubled and hasn't drifted", () => {
    expect(
      isRenameEligible({
        name: AGENT_NAME,
        centroid: ones(),
        memberCount: 5,
        lastNamedAtCount: 4,
        lastNamedCentroid: ones(),
      }),
    ).toBe(false);
  });
});
