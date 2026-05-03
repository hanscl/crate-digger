import { describe, expect, it } from "vitest";
import {
  addFeatureSample,
  emptyFeatureStats,
  featureVariance,
  updateCentroid,
} from "@/lib/bucketing/centroid";
import type { AudioFeatures } from "@/db/schema";

function audio(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    tempo: 120,
    energy: 0.5,
    valence: 0.5,
    danceability: 0.5,
    acousticness: 0.5,
    instrumentalness: 0.5,
    ...overrides,
  };
}

describe("Welford — updateCentroid", () => {
  it("matches the batch mean after a sequence of incremental updates", () => {
    // Mathematically, incremental Welford and full-batch averaging must
    // produce identical results. Drift here would silently corrupt every
    // bucket centroid in the system.
    const samples = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ];
    let centroid = samples[0]!;
    for (let i = 1; i < samples.length; i++) {
      centroid = updateCentroid(centroid, i, samples[i]!);
    }
    // Batch mean: ([1+5+9+13, 2+6+10+14, 3+7+11+15, 4+8+12+16] / 4)
    //          = ([28, 32, 36, 40] / 4) = [7, 8, 9, 10]
    for (let i = 0; i < centroid.length; i++) {
      expect(centroid[i]).toBeCloseTo([7, 8, 9, 10][i]!, 12);
    }
  });

  it("preserves a single-sample centroid unchanged when re-seeded with itself", () => {
    const v = [0.1, 0.2, 0.3];
    const next = updateCentroid(v, 1, v);
    for (let i = 0; i < v.length; i++) expect(next[i]).toBeCloseTo(v[i]!, 12);
  });

  it("throws on dim mismatch", () => {
    expect(() => updateCentroid([1, 2, 3], 1, [1, 2])).toThrow();
  });
});

describe("Welford — featureStats", () => {
  it("seed → first sample produces count=1, mean=sample, m2=0", () => {
    const stats = addFeatureSample(emptyFeatureStats(), audio({ tempo: 100 }));
    expect(stats.count).toBe(1);
    expect(stats.mean.tempo).toBe(100);
    expect(stats.m2.tempo).toBe(0);
  });

  it("computes the running mean correctly across N samples", () => {
    let stats = emptyFeatureStats();
    for (const t of [100, 120, 140]) {
      stats = addFeatureSample(stats, audio({ tempo: t }));
    }
    expect(stats.count).toBe(3);
    expect(stats.mean.tempo).toBeCloseTo(120, 9);
  });

  it("yields the textbook sample variance via Bessel's correction", () => {
    let stats = emptyFeatureStats();
    for (const t of [100, 120, 140]) {
      stats = addFeatureSample(stats, audio({ tempo: t }));
    }
    // Sample variance of [100, 120, 140] with n-1 = 2:
    //   ((100-120)² + (120-120)² + (140-120)²) / 2 = (400 + 0 + 400) / 2 = 400
    expect(featureVariance(stats).tempo).toBeCloseTo(400, 9);
  });

  it("variance is zero for fewer than two observations", () => {
    expect(featureVariance(emptyFeatureStats()).tempo).toBe(0);
    const one = addFeatureSample(emptyFeatureStats(), audio({ tempo: 100 }));
    expect(featureVariance(one).tempo).toBe(0);
  });

  it("does not mutate the previous stats object", () => {
    const a = addFeatureSample(emptyFeatureStats(), audio({ tempo: 100 }));
    const snapshot = JSON.parse(JSON.stringify(a));
    addFeatureSample(a, audio({ tempo: 200 }));
    expect(a).toEqual(snapshot);
  });
});
