/**
 * Pure helpers for the Buckets screen's recommendations panel (LAB-76).
 * Extracted from `buckets.tsx` so they unit-test in the node environment
 * without pulling React into the module graph (mirrors `queue-urls.ts`).
 *
 * The panel stays GLOBAL by design — it lists every pending merge/split. These
 * helpers add selection-awareness (highlight + sort recs touching the selected
 * bucket to the top) and turn the raw `reason` JSON into one deterministic
 * sentence. The reason shapes are produced by `src/lib/bucketing/recommendations.ts`:
 *
 *   - merge: `{ similarity: number, threshold: number }` — centroid cosine vs
 *     the merge threshold.
 *   - split: `{ memberCount, dislikeCount, dislikeRate, threshold }` — internal
 *     dislike rate vs the split bar.
 */

/** A bucket reference on a recommendation, after the server joins names in. */
export type RecBucketRef = { id: number; name: string | null; color: string | null };

/** The recommendation shape this panel renders (subset of the server payload). */
export type PanelRecommendation = {
  id: number;
  kind: "merge" | "split";
  bucketIds: number[];
  buckets: RecBucketRef[];
  reason: unknown;
};

/** True when the recommendation references the given bucket id. */
export function recInvolvesBucket(rec: PanelRecommendation, bucketId: number | null): boolean {
  return bucketId !== null && rec.bucketIds.includes(bucketId);
}

/**
 * Sort recommendations touching the selected bucket to the top, preserving the
 * server's relative order within each group (stable partition). With no
 * selection the input order is preserved. Returns a new array — never mutates.
 */
export function orderRecommendations<T extends PanelRecommendation>(
  recs: readonly T[],
  selectedBucketId: number | null,
): T[] {
  if (selectedBucketId === null) return [...recs];
  const involved: T[] = [];
  const rest: T[] = [];
  for (const r of recs) {
    if (recInvolvesBucket(r, selectedBucketId)) involved.push(r);
    else rest.push(r);
  }
  return [...involved, ...rest];
}

/** Human label for a bucket reference — its name, or a `#id` fallback when the
 *  name didn't resolve (a referenced bucket was pruned before recompute). */
export function bucketRefLabel(ref: RecBucketRef): string {
  return ref.name ?? `#${ref.id}`;
}

function fmt(n: unknown, digits = 2): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * One-line deterministic sentence for a recommendation's `reason`, phrased
 * against the joined bucket names. Falls back to a generic line if the reason
 * shape is unexpected (forward-compatible — the raw JSON stays available behind
 * the panel's collapsible toggle).
 */
export function formatRecommendationReason(rec: PanelRecommendation): string {
  const names = rec.buckets.map(bucketRefLabel);
  const reason = (rec.reason ?? {}) as Record<string, unknown>;

  if (rec.kind === "merge") {
    const sim = asNumber(reason.similarity);
    const threshold = asNumber(reason.threshold);
    const pair = names.length === 2 ? `${names[0]} + ${names[1]}` : names.join(" + ");
    if (sim === null || threshold === null) return `Merge ${pair}.`;
    return `Centroids are ${fmt(sim)} similar (≥ ${fmt(threshold)} merge bar) — merge ${pair}.`;
  }

  // split
  const rate = asNumber(reason.dislikeRate);
  const threshold = asNumber(reason.threshold);
  const dislikeCount = asNumber(reason.dislikeCount);
  const memberCount = asNumber(reason.memberCount);
  const target = names[0] ?? "this bucket";
  if (rate === null || threshold === null) return `Split ${target}.`;
  const pct = (rate * 100).toFixed(0);
  const barPct = (threshold * 100).toFixed(0);
  const counts =
    dislikeCount !== null && memberCount !== null
      ? ` (${dislikeCount}/${memberCount} disliked)`
      : "";
  return `${pct}% dislike rate${counts} exceeds the ${barPct}% split bar — split ${target}.`;
}
