import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "@/db/schema";
import { scoreBroad, trainBroadClassifier } from "@/lib/ranking/broad";
import { isBroadConfig } from "@/lib/ranking/types";
import type { Candidate } from "@/lib/ranking/types";

function candidate(trackId: number, embedding: number[]): Candidate {
  return { trackId, embedding };
}

describe("trainBroadClassifier — logistic regression on embeddings", () => {
  it("learns to separate two clearly-distinct populations", () => {
    // Two well-separated 4-dim populations: keeps cluster around [1,1,0,0],
    // dislikes around [0,0,1,1]. The trained model should score keep-shaped
    // candidates near 1 and dislike-shaped near 0.
    const samples: { embedding: number[]; label: 0 | 1 }[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push({ embedding: [1 + jitter(i), 1 + jitter(i + 1), 0, 0], label: 1 });
      samples.push({ embedding: [0, 0, 1 + jitter(i), 1 + jitter(i + 1)], label: 0 });
    }
    const result = trainBroadClassifier(samples, { iterations: 400 });
    expect(result.config.weights).not.toBeNull();
    expect(result.config.trainedSampleCount).toBe(40);
    expect(result.finalLoss).toBeLessThan(0.4);

    const keepLike = scoreBroad(candidate(1, [1, 1, 0, 0]), result.config);
    const dislikeLike = scoreBroad(candidate(2, [0, 0, 1, 1]), result.config);
    expect(keepLike.score).toBeGreaterThan(0.7);
    expect(dislikeLike.score).toBeLessThan(0.3);
    expect(keepLike.subScores.untrained).toBe(0);
  });

  it("learns negative coefficients on disliked-genre dimensions — Constraint #4", () => {
    // Genre dim 0 is what the user dislikes; dim 1 is what they keep. Build
    // a clean signal so weights[0] should be < 0 and weights[1] > 0. Then
    // confirm a candidate carrying the disliked genre still gets a SCORE
    // (not filtered out) — just a lower one. This is the core Constraint #4
    // guarantee at the ranker layer.
    const samples: { embedding: number[]; label: 0 | 1 }[] = [];
    for (let i = 0; i < 20; i++) {
      // disliked-genre track: weights[0] should pull score down
      samples.push({ embedding: [1, 0], label: 0 });
      // kept-genre track: weights[1] should pull score up
      samples.push({ embedding: [0, 1], label: 1 });
    }
    const result = trainBroadClassifier(samples, { iterations: 400 });
    expect(result.config.weights?.[0]).toBeLessThan(0);
    expect(result.config.weights?.[1]).toBeGreaterThan(0);

    // Disliked-genre candidate is scored (not filtered), gets a low score.
    const disliked = scoreBroad(candidate(1, [1, 0]), result.config);
    expect(Number.isFinite(disliked.score)).toBe(true);
    expect(disliked.score).toBeLessThan(0.3);
    expect(disliked.subScores.untrained).toBe(0);
  });

  it("returns an untrained config when only one class is present (no decision boundary)", () => {
    const samples: { embedding: number[]; label: 0 | 1 }[] = [];
    for (let i = 0; i < 5; i++) samples.push({ embedding: [1, 0], label: 1 });
    const r = trainBroadClassifier(samples);
    expect(r.config.weights).toBeNull();
    expect(r.config.trainedSampleCount).toBe(5);
    expect(r.config.prior).toBe(1);
    expect(r.iterations).toBe(0);
  });

  it("returns an untrained config with prior=0.5 when no samples are provided", () => {
    const r = trainBroadClassifier([]);
    expect(r.config.weights).toBeNull();
    expect(r.config.trainedSampleCount).toBe(0);
    expect(r.config.prior).toBe(0.5);
  });

  it("score on an untrained config returns the prior — system is usable from day 0", () => {
    const r = trainBroadClassifier([]);
    const a = scoreBroad(candidate(1, [1, 2, 3, 4]), r.config);
    const b = scoreBroad(candidate(2, [-1, -2, -3, -4]), r.config);
    expect(a.score).toBe(0.5);
    expect(b.score).toBe(0.5);
    expect(a.subScores.untrained).toBe(1);
    expect(a.rankerKind).toBe("broad");
  });

  it("rejects mismatched embedding dimensions — refuses to train on inconsistent data", () => {
    const samples: { embedding: number[]; label: 0 | 1 }[] = [
      { embedding: [1, 0, 0], label: 1 },
      { embedding: [0, 1], label: 0 },
    ];
    expect(() => trainBroadClassifier(samples)).toThrow(/dim mismatch/);
  });

  it("scoreBroad throws on a candidate whose embedding dim doesn't match the trained weights", () => {
    // Training-time mismatch is caught by trainBroadClassifier; inference-time
    // mismatch must be caught by scoreBroad too — silently truncating to the
    // shorter side would mask embedding/config corruption (e.g., a model
    // trained at one EMBEDDING_DIM scored against candidates built at another).
    const samples: { embedding: number[]; label: 0 | 1 }[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push({ embedding: [1, 1, 0], label: 1 });
      samples.push({ embedding: [0, 0, 1], label: 0 });
    }
    const trained = trainBroadClassifier(samples, { iterations: 50 });
    expect(trained.config.weights).toHaveLength(3);
    expect(() => scoreBroad(candidate(1, [1, 0]), trained.config)).toThrow(/dim mismatch/);
  });
});

describe("isBroadConfig — trust-boundary guard", () => {
  it("rejects weights whose length doesn't match EMBEDDING_DIM", () => {
    // A model trained at a pre-refactor dim (or otherwise mis-shaped) that
    // slips through the guard would only fail at inference time, crashing
    // surfacing. Catch it here.
    const wrongDim = Array.from({ length: EMBEDDING_DIM - 1 }, () => 0);
    const cfg = { weights: wrongDim, bias: 0, trainedSampleCount: 1 };
    expect(isBroadConfig(cfg)).toBe(false);
  });

  it("accepts weights of length EMBEDDING_DIM and a null (untrained) weights field", () => {
    const trained = {
      weights: Array.from({ length: EMBEDDING_DIM }, () => 0),
      bias: 0,
      trainedSampleCount: 1,
    };
    expect(isBroadConfig(trained)).toBe(true);

    const untrained = { weights: null, bias: 0, trainedSampleCount: 0, prior: 0.5 };
    expect(isBroadConfig(untrained)).toBe(true);
  });

  it("rejects non-integer or negative trainedSampleCount — it's a count, not a float", () => {
    const fractional = { weights: null, bias: 0, trainedSampleCount: 3.5 };
    expect(isBroadConfig(fractional)).toBe(false);

    const negative = { weights: null, bias: 0, trainedSampleCount: -1 };
    expect(isBroadConfig(negative)).toBe(false);
  });

  it("rejects prior outside [0, 1] — it's a probability, not an arbitrary scalar", () => {
    const tooLow = { weights: null, bias: 0, trainedSampleCount: 0, prior: -0.1 };
    expect(isBroadConfig(tooLow)).toBe(false);

    const tooHigh = { weights: null, bias: 0, trainedSampleCount: 0, prior: 1.1 };
    expect(isBroadConfig(tooHigh)).toBe(false);

    const boundary0 = { weights: null, bias: 0, trainedSampleCount: 0, prior: 0 };
    const boundary1 = { weights: null, bias: 0, trainedSampleCount: 0, prior: 1 };
    expect(isBroadConfig(boundary0)).toBe(true);
    expect(isBroadConfig(boundary1)).toBe(true);
  });
});

/** Tiny deterministic noise — enough variance to keep the optimizer honest. */
function jitter(seed: number): number {
  return ((seed * 1103515245 + 12345) % 1000) / 100000;
}
