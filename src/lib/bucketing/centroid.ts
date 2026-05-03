import type { AudioFeatures, FeatureStats } from "@/db/schema";
import { FEATURE_KEYS, ZERO_AUDIO } from "@/lib/embedding";

/**
 * Welford incremental statistics. Pure math — no DB. Two parallel running
 * means are maintained per bucket:
 *
 *   - `centroid` (64-dim): the average embedding, used for cosine similarity
 *     in spawn-or-join and for ranking.
 *   - `feature_stats`: per-AudioFeature mean + sum-of-squared-deviations (M2),
 *     used to compute variance/dispersion for the bucket radar viz and
 *     merge/split heuristics later.
 *
 * Both share `count` = number of contributing observations. A bucket's first
 * member seeds the stats; subsequent members extend them via Welford. We
 * never recompute from scratch — this matters when a bucket has thousands
 * of members and ratings stream in over time.
 */

/** Featureless bucket seed: count=0, all zeros. Caller will Welford-add the first sample. */
export function emptyFeatureStats(): FeatureStats {
  return {
    count: 0,
    mean: { ...ZERO_AUDIO },
    m2: { ...ZERO_AUDIO },
  };
}

/** Welford-add a single AudioFeatures sample to running stats. Pure. */
export function addFeatureSample(prev: FeatureStats, sample: AudioFeatures): FeatureStats {
  const count = prev.count + 1;
  const mean: AudioFeatures = { ...prev.mean };
  const m2: AudioFeatures = { ...prev.m2 };
  for (const k of FEATURE_KEYS) {
    const x = sample[k];
    const delta = x - mean[k];
    mean[k] = mean[k] + delta / count;
    const delta2 = x - mean[k];
    m2[k] = m2[k] + delta * delta2;
  }
  return { count, mean, m2 };
}

/** Sample variance (Bessel's correction). Zero when count < 2. */
export function featureVariance(stats: FeatureStats): AudioFeatures {
  if (stats.count < 2) return { ...ZERO_AUDIO };
  const out: AudioFeatures = { ...ZERO_AUDIO };
  for (const k of FEATURE_KEYS) {
    out[k] = stats.m2[k] / (stats.count - 1);
  }
  return out;
}

/**
 * Incrementally update the centroid (running mean of the embedding) given
 * the new member count. Mathematically equivalent to recomputing the mean
 * from all members; we use the incremental form for O(d) instead of O(n·d).
 */
export function updateCentroid(
  prevCentroid: readonly number[],
  prevCount: number,
  sample: readonly number[],
): number[] {
  if (prevCentroid.length !== sample.length) {
    throw new Error(`updateCentroid: dim mismatch ${prevCentroid.length} vs ${sample.length}`);
  }
  const newCount = prevCount + 1;
  const next: number[] = Array.from({ length: prevCentroid.length }, () => 0);
  for (let i = 0; i < prevCentroid.length; i++) {
    const c = prevCentroid[i] ?? 0;
    const s = sample[i] ?? 0;
    next[i] = c + (s - c) / newCount;
  }
  return next;
}
