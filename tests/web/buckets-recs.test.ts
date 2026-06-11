import { describe, expect, it } from "vitest";
import {
  bucketRefLabel,
  formatRecommendationReason,
  orderRecommendations,
  type PanelRecommendation,
  recInvolvesBucket,
} from "@/web/screens/buckets-recs";

function mergeRec(
  id: number,
  ids: [number, number],
  names: [string | null, string | null],
  reason: unknown,
): PanelRecommendation {
  return {
    id,
    kind: "merge",
    bucketIds: ids,
    buckets: [
      { id: ids[0], name: names[0], color: null },
      { id: ids[1], name: names[1], color: null },
    ],
    reason,
  };
}

function splitRec(
  id: number,
  bid: number,
  name: string | null,
  reason: unknown,
): PanelRecommendation {
  return {
    id,
    kind: "split",
    bucketIds: [bid],
    buckets: [{ id: bid, name, color: null }],
    reason,
  };
}

describe("recInvolvesBucket", () => {
  it("is true when the bucket id is referenced", () => {
    const rec = mergeRec(1, [4, 17], ["A", "B"], { similarity: 0.95, threshold: 0.92 });
    expect(recInvolvesBucket(rec, 17)).toBe(true);
    expect(recInvolvesBucket(rec, 4)).toBe(true);
  });

  it("is false for an unrelated bucket or a null selection", () => {
    const rec = mergeRec(1, [4, 17], ["A", "B"], {});
    expect(recInvolvesBucket(rec, 99)).toBe(false);
    expect(recInvolvesBucket(rec, null)).toBe(false);
  });
});

describe("orderRecommendations", () => {
  const a = mergeRec(1, [4, 17], ["A", "B"], {});
  const b = splitRec(2, 9, "C", {});
  const c = mergeRec(3, [9, 12], ["C", "D"], {});

  it("hoists recs touching the selected bucket to the top, stable within groups", () => {
    const ordered = orderRecommendations([a, b, c], 9);
    expect(ordered.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("preserves input order when nothing is selected", () => {
    expect(orderRecommendations([a, b, c], null).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("does not mutate the input array", () => {
    const input = [a, b, c];
    orderRecommendations(input, 9);
    expect(input.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe("bucketRefLabel", () => {
  it("uses the name when present", () => {
    expect(bucketRefLabel({ id: 4, name: "Synthwave", color: null })).toBe("Synthwave");
  });

  it("falls back to #id when the name didn't resolve (pruned bucket)", () => {
    expect(bucketRefLabel({ id: 4, name: null, color: null })).toBe("#4");
  });
});

describe("formatRecommendationReason — merge", () => {
  it("phrases centroid similarity vs the merge bar with bucket names", () => {
    const rec = mergeRec(1, [4, 17], ["Synthwave", "Italo Disco"], {
      similarity: 0.953,
      threshold: 0.92,
    });
    expect(formatRecommendationReason(rec)).toBe(
      "Centroids are 0.95 similar (≥ 0.92 merge bar) — merge Synthwave + Italo Disco.",
    );
  });

  it("uses the #id fallback when a name is missing", () => {
    const rec = mergeRec(1, [4, 17], ["Synthwave", null], {
      similarity: 0.95,
      threshold: 0.92,
    });
    expect(formatRecommendationReason(rec)).toContain("merge Synthwave + #17.");
  });

  it("degrades to a generic line on an unexpected reason shape", () => {
    const rec = mergeRec(1, [4, 17], ["A", "B"], { unexpected: true });
    expect(formatRecommendationReason(rec)).toBe("Merge A + B.");
  });
});

describe("formatRecommendationReason — split", () => {
  it("phrases dislike rate vs the split bar with counts", () => {
    const rec = splitRec(2, 9, "Lo-fi Beats", {
      memberCount: 8,
      dislikeCount: 5,
      dislikeRate: 0.625,
      threshold: 0.5,
    });
    expect(formatRecommendationReason(rec)).toBe(
      "63% dislike rate (5/8 disliked) exceeds the 50% split bar — split Lo-fi Beats.",
    );
  });

  it("degrades to a generic line on an unexpected reason shape", () => {
    const rec = splitRec(2, 9, "Lo-fi Beats", {});
    expect(formatRecommendationReason(rec)).toBe("Split Lo-fi Beats.");
  });
});
