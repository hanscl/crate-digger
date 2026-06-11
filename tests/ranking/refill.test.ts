import { describe, expect, it } from "vitest";
import type { AudioFeatures } from "@/db/schema";
import { AUDIO_FEATURE_DIM, buildEmbedding, cosine, weightedCosine } from "@/lib/embedding";
import { scoreRefill, scoreRefillBatch } from "@/lib/ranking/refill";
import {
  type Candidate,
  isRefillConfig,
  type RatedTrack,
  type RefillConfig,
} from "@/lib/ranking/types";

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

describe("scoreRefill — audio-weighted metric (LAB-36)", () => {
  const af = (overrides: Partial<AudioFeatures>): AudioFeatures => ({
    tempo: 120,
    energy: 0.5,
    valence: 0.5,
    danceability: 0.5,
    acousticness: 0.5,
    instrumentalness: 0.5,
    ...overrides,
  });

  it("keepSim AND dislikeSim use weightedCosine at config.audioWeight for audio-bearing candidates", () => {
    const candAudio = af({ energy: 0.9, acousticness: 0.1 });
    const cand: Candidate = {
      trackId: 1,
      embedding: buildEmbedding({ audioFeatures: candAudio, genres: ["rock"] }),
      audioFeatures: candAudio,
    };
    const keep = rated(2, buildEmbedding({ audioFeatures: af({ energy: 0.8 }), genres: ["jazz"] }));
    const dislike = rated(
      3,
      buildEmbedding({ audioFeatures: af({ energy: 0.1 }), genres: ["rock"] }),
    );
    const config: RefillConfig = { lambda: 0.5, audioWeight: 3, genreGate: "slot-overlap" };
    const r = scoreRefill(cand, [keep], [dislike], config);
    expect(r.subScores.keepSim).toBeCloseTo(weightedCosine(cand.embedding, keep.embedding, 3), 12);
    expect(r.subScores.dislikeSim).toBeCloseTo(
      weightedCosine(cand.embedding, dislike.embedding, 3),
      12,
    );
    // The weighting matters: it must differ from the unweighted metric.
    expect(r.subScores.keepSim).not.toBeCloseTo(cosine(cand.embedding, keep.embedding), 4);
  });

  it("legacy {lambda}-only config scores byte-identically to plain cosine (v1 replays unchanged)", () => {
    const candAudio = af({ energy: 0.9 });
    const cand: Candidate = {
      trackId: 1,
      embedding: buildEmbedding({ audioFeatures: candAudio, genres: ["rock"] }),
      audioFeatures: candAudio,
    };
    const keep = rated(2, buildEmbedding({ audioFeatures: af({ energy: 0.4 }), genres: ["rock"] }));
    const dislike = rated(3, buildEmbedding({ audioFeatures: af({ tempo: 80 }), genres: ["pop"] }));
    const legacy = scoreRefill(cand, [keep], [dislike], { lambda: 0.3 });
    // toBe, not toBeCloseTo: audioWeight=1 multiplies every dim by 1, which
    // is exact in IEEE 754 — the legacy path is bit-identical.
    expect(legacy.subScores.keepSim).toBe(cosine(cand.embedding, keep.embedding));
    expect(legacy.subScores.dislikeSim).toBe(cosine(cand.embedding, dislike.embedding));
  });

  it("null-audio damping: a candidate without audio features scores at weight 1 even under a weighted config", () => {
    const cand: Candidate = {
      trackId: 1,
      embedding: buildEmbedding({ audioFeatures: null, genres: ["rock"] }),
      audioFeatures: null,
    };
    const keep = rated(2, buildEmbedding({ audioFeatures: af({}), genres: ["rock"] }));
    const weighted = scoreRefill(cand, [keep], [], {
      lambda: 0.3,
      audioWeight: 4,
      genreGate: "slot-overlap",
    });
    expect(weighted.subScores.keepSim).toBe(cosine(cand.embedding, keep.embedding));
    // Sanity: the candidate's audio dims really are the neutral fills.
    for (let i = 0; i < AUDIO_FEATURE_DIM; i++) expect(cand.embedding[i]).toBe(0.5);
  });
});

describe("isRefillConfig — trust-boundary guard (LAB-36 fields)", () => {
  it("accepts a legacy {lambda}-only config (pre-LAB-36 versions stay valid)", () => {
    expect(isRefillConfig({ lambda: 0.3 })).toBe(true);
  });

  it("accepts the full LAB-36 shape", () => {
    expect(isRefillConfig({ lambda: 0.3, audioWeight: 2.5, genreGate: "slot-overlap" })).toBe(true);
    expect(isRefillConfig({ lambda: 0.3, audioWeight: 1, genreGate: "exact" })).toBe(true);
  });

  it("rejects non-finite or sub-1 audioWeight", () => {
    expect(isRefillConfig({ lambda: 0.3, audioWeight: Number.NaN })).toBe(false);
    expect(isRefillConfig({ lambda: 0.3, audioWeight: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isRefillConfig({ lambda: 0.3, audioWeight: 0.5 })).toBe(false);
    expect(isRefillConfig({ lambda: 0.3, audioWeight: -2 })).toBe(false);
  });

  it("rejects unknown genreGate strings", () => {
    expect(isRefillConfig({ lambda: 0.3, genreGate: "fuzzy" })).toBe(false);
  });

  it("still rejects a non-finite lambda", () => {
    expect(isRefillConfig({ lambda: Number.NaN })).toBe(false);
    expect(isRefillConfig({})).toBe(false);
    expect(isRefillConfig(null)).toBe(false);
  });
});
