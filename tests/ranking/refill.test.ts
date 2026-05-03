import { describe, expect, it } from "vitest";
import { scoreRefill, scoreRefillBatch } from "@/lib/ranking/refill";
import type { Candidate, RatedTrack, RefillConfig } from "@/lib/ranking/types";

const CONFIG: RefillConfig = { lambda: 0.5 };

function emb(...nums: number[]): number[] {
  return nums;
}

function candidate(trackId: number, embedding: number[]): Candidate {
  return { trackId, embedding };
}

function rated(trackId: number, embedding: number[]): RatedTrack {
  return { trackId, embedding };
}

describe("scoreRefill — pure ranker math", () => {
  it("score equals mean keep cosine when there are no dislikes", () => {
    // Two keeps, both equal to candidate → cosine=1 each → mean=1 → score=1.
    // No dislike penalty since dislikes is empty.
    const c = candidate(1, emb(1, 0, 0, 0));
    const keeps = [rated(2, emb(1, 0, 0, 0)), rated(3, emb(1, 0, 0, 0))];
    const r = scoreRefill(c, keeps, [], CONFIG);
    expect(r.score).toBeCloseTo(1, 12);
    expect(r.subScores.keepSim).toBeCloseTo(1, 12);
    expect(r.subScores.dislikeSim).toBe(0);
    expect(r.rankerKind).toBe("refill");
  });

  it("dislike similarity reduces score by lambda — soft penalty, no filter (Constraint #4)", () => {
    // Pure dislike penalty: keeps empty, candidate equals dislike → keep_sim=0,
    // dislike_sim=1 → score = 0 − 0.5*1 = −0.5. Critically, the candidate is
    // STILL scored (returned) — refill never filters candidates out.
    const c = candidate(1, emb(1, 0));
    const dislikes = [rated(2, emb(1, 0))];
    const r = scoreRefill(c, [], dislikes, CONFIG);
    expect(r.score).toBeCloseTo(-0.5, 12);
    expect(r.subScores.keepSim).toBe(0);
    expect(r.subScores.dislikeSim).toBeCloseTo(1, 12);
  });

  it("returns 0 score when both keep and dislike sets are empty", () => {
    // First-run / empty-state — refill produces a usable, deterministic score.
    const r = scoreRefill(candidate(1, emb(1, 0)), [], [], CONFIG);
    expect(r.score).toBe(0);
    expect(r.subScores.keepSim).toBe(0);
    expect(r.subScores.dislikeSim).toBe(0);
  });

  it("scores a batch independently — order in input is preserved in output", () => {
    const candidates = [candidate(1, emb(1, 0)), candidate(2, emb(0, 1)), candidate(3, emb(-1, 0))];
    const keeps = [rated(99, emb(1, 0))];
    const out = scoreRefillBatch(candidates, keeps, [], CONFIG);
    expect(out.map((s) => s.candidate.trackId)).toEqual([1, 2, 3]);
    expect(out[0]?.score).toBeCloseTo(1, 12);
    expect(out[1]?.score).toBeCloseTo(0, 12);
    expect(out[2]?.score).toBeCloseTo(-1, 12);
  });

  it("higher lambda penalizes dislikes harder (monotone in lambda)", () => {
    const c = candidate(1, emb(1, 0));
    const keeps = [rated(2, emb(1, 0))];
    const dislikes = [rated(3, emb(1, 0))];
    const lo = scoreRefill(c, keeps, dislikes, { lambda: 0 }).score;
    const mid = scoreRefill(c, keeps, dislikes, { lambda: 0.5 }).score;
    const hi = scoreRefill(c, keeps, dislikes, { lambda: 1 }).score;
    expect(lo).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(hi);
  });
});
