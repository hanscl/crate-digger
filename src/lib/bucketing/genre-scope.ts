import { genreSlotsFromVector, hasSlotOverlap } from "@/lib/embedding";

/**
 * Genre-compatibility predicate shared by the bucket JOIN gate (assign.ts),
 * the refill winner-eligibility gate (surfacing pipeline), and the
 * counterfactual replay gate. Which gate applies is selected PER MODEL
 * VERSION via `RefillConfig.genreGate` — old versions replay under 'exact',
 * LAB-36+ versions run 'slot-overlap' — so historical replays are never
 * silently re-gated. The MERGE gate (recommendations.ts) deliberately stays
 * exact-match: merging is destructive-ish and conservative asymmetry is the
 * point.
 *
 *   - 'exact'        — LAB-45 rule: candidate primary genre === bucket primary
 *                      genre, null matches null.
 *   - 'slot-overlap' — LAB-36 rule: the track's genre-slot set (its embedding
 *                      genre dims) shares ≥1 slot with the bucket's centroid
 *                      genre mass (slot on iff ANY member contributed it —
 *                      order-insensitive by construction). Last.fm tags are
 *                      artist-scoped, so exact primary-genre matching locks
 *                      e.g. a metal-tagged acoustic ballad out of every
 *                      non-metal bucket; slot overlap keeps a taxonomy link
 *                      while the audio-weighted cosine decides nearness.
 *
 * 'slot-overlap' degenerate cases (preserve today's lanes exactly):
 *   - A track with ZERO genre slots (null-genre, or raw tags matching no
 *     slot) falls back to exact primary-genre equality — same rule as today
 *     for those tracks, null===null included.
 *   - A slotted track is NOT compatible with a zero-genre-mass bucket.
 */
export type GenreGate = "exact" | "slot-overlap";

export type GenreScopeTrack = {
  primaryGenre: string | null | undefined;
  /** Full embedding (audio + genre dims). Absent/null counts as zero slots. */
  embedding: readonly number[] | null | undefined;
};

export type GenreScopeBucket = {
  primaryGenre: string | null;
  centroid: readonly number[];
};

export function genreScopeCompatible(
  gate: GenreGate,
  track: GenreScopeTrack,
  bucket: GenreScopeBucket,
): boolean {
  if (gate === "exact") return sameGenreScope(track.primaryGenre, bucket.primaryGenre);
  const trackSlots = track.embedding ? genreSlotsFromVector(track.embedding) : new Set<number>();
  if (trackSlots.size === 0) return sameGenreScope(track.primaryGenre, bucket.primaryGenre);
  return hasSlotOverlap(trackSlots, genreSlotsFromVector(bucket.centroid));
}

/**
 * The 'exact' rule (LAB-45): same primary genre, null matches null. Still the
 * MERGE gate's rule (recommendations.ts) and the 'slot-overlap' fallback for
 * zero-slot tracks.
 */
export function sameGenreScope(
  candidatePrimaryGenre: string | null | undefined,
  bucketPrimaryGenre: string | null,
): boolean {
  return (candidatePrimaryGenre ?? null) === bucketPrimaryGenre;
}
