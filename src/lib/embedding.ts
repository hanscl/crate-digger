import { type AudioFeatures, EMBEDDING_DIM } from "@/db/schema";

/**
 * Hand-crafted feature-vector builder. Single source of truth for
 * (track | bucket) → 64-dim embedding used for cosine similarity in bucketing
 * and ranking. Composed of:
 *
 *   [0]    tempo, normalized via z-score → sigmoid
 *   [1..5] energy, valence, danceability, acousticness, instrumentalness (already 0..1)
 *   [6..]  58-slot genre multi-hot (top-level taxonomy below)
 *
 * If a dimension change is needed, bump `EMBEDDING_DIM` in `schema.ts`,
 * regenerate migrations, and update the slot list here in lock-step.
 */

export const AUDIO_FEATURE_DIM = 6;

export const FEATURE_KEYS = [
  "tempo",
  "energy",
  "valence",
  "danceability",
  "acousticness",
  "instrumentalness",
] as const satisfies readonly (keyof AudioFeatures)[];

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * Coarse genre taxonomy. Each slot has a list of keywords matched as
 * contiguous token subsequences of normalized genre tags. Multi-hot:
 * one track may set multiple slots (e.g. "indie rock" sets `indie`).
 *
 * LAB-47 — `blockedByTokens`: a slot whose keyword is a broad genre-family
 * token (e.g. bare "rock", shared by metal/hard-rock) is suppressed for any
 * single tag that ALSO carries a cross-family qualifier token. "pop rock" and
 * "indie rock" are pop/indie tracks that happen to borrow the rock idiom — they
 * belong in the pop/indie lane, not the rock-vs-metal lane that "hard rock",
 * "classic rock", "punk rock" and bare "rock" share. Without this, substring-ish
 * token-subsequence matching lit the bare `rock` slot for "pop rock"/"indie rock",
 * creating spurious cross-genre affinity (e.g. a pop-rock act overlapping the
 * metal bucket via the shared `rock` slot). The block is per-TAG: a track tagged
 * both "pop rock" and bare "rock" still lights `rock` from the bare tag — only
 * the qualified tag is suppressed. The qualifier still lights its own slot
 * (`pop` / `indie`), so the genre signal is not lost, just routed correctly.
 */
type GenreSlotDef = {
  slot: string;
  keywords: readonly string[];
  /**
   * Tokens that, when present in the SAME tag as a matched keyword, suppress
   * this slot for that tag (route it to the qualifier's lane instead).
   */
  blockedByTokens?: readonly string[];
};

const GENRE_SLOT_DEFS: readonly GenreSlotDef[] = [
  { slot: "rock", keywords: ["rock"], blockedByTokens: ["pop", "indie"] },
  { slot: "indie", keywords: ["indie"] },
  { slot: "alternative", keywords: ["alternative", "alt rock"] },
  { slot: "punk", keywords: ["punk"] },
  { slot: "hardcore", keywords: ["hardcore"] },
  { slot: "metal", keywords: ["metal"] },
  { slot: "prog", keywords: ["prog", "progressive"] },
  { slot: "post-rock", keywords: ["post rock"] },
  { slot: "shoegaze", keywords: ["shoegaze"] },
  { slot: "pop", keywords: ["pop"] },
  { slot: "synth-pop", keywords: ["synth pop", "synthpop"] },
  { slot: "dream-pop", keywords: ["dream pop", "dreampop"] },
  { slot: "dance-pop", keywords: ["dance pop"] },
  { slot: "k-pop", keywords: ["k pop", "kpop"] },
  { slot: "j-pop", keywords: ["j pop", "jpop"] },
  { slot: "hip-hop", keywords: ["hip hop", "hiphop"] },
  { slot: "rap", keywords: ["rap"] },
  { slot: "trap", keywords: ["trap"] },
  { slot: "drill", keywords: ["drill"] },
  { slot: "grime", keywords: ["grime"] },
  { slot: "rnb", keywords: ["r b", "rnb", "rhythm and blues"] },
  { slot: "soul", keywords: ["soul"] },
  { slot: "funk", keywords: ["funk"] },
  { slot: "disco", keywords: ["disco"] },
  { slot: "motown", keywords: ["motown"] },
  { slot: "electronic", keywords: ["electronic", "electronica"] },
  { slot: "house", keywords: ["house"] },
  { slot: "techno", keywords: ["techno"] },
  { slot: "trance", keywords: ["trance"] },
  { slot: "drum-and-bass", keywords: ["drum and bass", "dnb", "drum n bass"] },
  { slot: "dubstep", keywords: ["dubstep"] },
  { slot: "breakbeat", keywords: ["breakbeat", "breaks"] },
  { slot: "ambient", keywords: ["ambient"] },
  { slot: "idm", keywords: ["idm", "intelligent dance"] },
  { slot: "downtempo", keywords: ["downtempo"] },
  { slot: "lo-fi", keywords: ["lo fi", "lofi"] },
  { slot: "vaporwave", keywords: ["vaporwave"] },
  { slot: "synthwave", keywords: ["synthwave"] },
  { slot: "jazz", keywords: ["jazz"] },
  { slot: "blues", keywords: ["blues"] },
  { slot: "bebop", keywords: ["bebop"] },
  { slot: "swing", keywords: ["swing"] },
  { slot: "fusion", keywords: ["fusion"] },
  { slot: "classical", keywords: ["classical"] },
  { slot: "opera", keywords: ["opera"] },
  { slot: "baroque", keywords: ["baroque"] },
  { slot: "folk", keywords: ["folk"] },
  { slot: "country", keywords: ["country"] },
  { slot: "bluegrass", keywords: ["bluegrass"] },
  { slot: "latin", keywords: ["latin"] },
  { slot: "reggae", keywords: ["reggae"] },
  { slot: "ska", keywords: ["ska"] },
  { slot: "afrobeat", keywords: ["afrobeat", "afrobeats"] },
  { slot: "world", keywords: ["world"] },
  { slot: "gospel", keywords: ["gospel"] },
  { slot: "christian", keywords: ["christian"] },
  { slot: "soundtrack", keywords: ["soundtrack", "score", "ost"] },
  { slot: "experimental", keywords: ["experimental"] },
];

export const GENRE_SLOTS: readonly string[] = GENRE_SLOT_DEFS.map((s) => s.slot);
export const GENRE_DIM = GENRE_SLOTS.length;

// Compile-time guard: dim parts must add up to the schema's vector size.
const _DIM_CHECK: typeof AUDIO_FEATURE_DIM extends number ? number : never =
  AUDIO_FEATURE_DIM + GENRE_DIM;
if (_DIM_CHECK !== EMBEDDING_DIM) {
  throw new Error(
    `embedding.ts dimension mismatch: ${AUDIO_FEATURE_DIM} + ${GENRE_DIM} ≠ ${EMBEDDING_DIM}`,
  );
}

const TEMPO_MEAN_BPM = 120;
const TEMPO_STD_BPM = 30;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Tempo z-scored against a fixed prior, then squashed to (0,1). */
export function normalizeTempo(bpm: number): number {
  return sigmoid((bpm - TEMPO_MEAN_BPM) / TEMPO_STD_BPM);
}

/**
 * Project audio features into the 6-dim audio segment of the embedding.
 * `null` audio yields a neutral 0.5 across the board so cosine similarity
 * remains well-defined for tracks lacking Spotify features.
 *
 * LAB-48 — the 0.5 fills stay (stored pgvector embeddings must remain
 * real-valued for HNSW; re-embedding would break counterfactual replay), but
 * they are a constant, non-discriminating signal that still contributes to
 * cosine and so made null-audio tracks look audio-similar to everything. The
 * refill metric now EXCLUDES the audio block for a null-audio candidate (via
 * the version-gated coverage gate — `weightedCosine(.,.,0)`), so the fills no
 * longer inflate similarity. Comparison-side change only; keep returning 0.5.
 */
export function audioFeaturesToVector(af: AudioFeatures | null): number[] {
  if (!af) return Array.from({ length: AUDIO_FEATURE_DIM }, () => 0.5);
  return [
    normalizeTempo(af.tempo),
    clamp01(af.energy),
    clamp01(af.valence),
    clamp01(af.danceability),
    clamp01(af.acousticness),
    clamp01(af.instrumentalness),
  ];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeGenreString(g: string): string[] {
  return g
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokensContain(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Whether a single tag's normalized tokens match a slot keyword and survive
 * the slot's `blockedByTokens` guard. Returns the LONGEST matched keyword (so
 * callers can break ties on keyword specificity) or null. Returning the longest
 * — not the first — keeps {@link derivePrimaryGenre}'s most-specific-wins tie-break
 * faithful for slots whose keyword list isn't ordered longest-first (e.g. `rnb`
 * lists `"r b"` before `"rhythm and blues"`). Shared by {@link genresToHotVector}
 * (which uses it only as a boolean) and {@link derivePrimaryGenre} so the multi-hot
 * vector and the primary-genre label can never disagree on what a tag matches.
 */
function tagMatchedKeyword(tagTokens: readonly string[], def: GenreSlotDef): string | null {
  let best: string | null = null;
  for (const kw of def.keywords) {
    if (!tokensContain(tagTokens, kw.split(/\s+/))) continue;
    // LAB-47 — a cross-family qualifier in the SAME tag routes it elsewhere.
    if (def.blockedByTokens?.some((t) => tagTokens.includes(t))) continue;
    if (best === null || kw.length > best.length) best = kw;
  }
  return best;
}

/** Multi-hot 58-dim genre vector. Each slot is 1 iff any input genre matches it. */
export function genresToHotVector(genres: readonly string[]): number[] {
  const vec: number[] = Array.from({ length: GENRE_DIM }, () => 0);
  if (genres.length === 0) return vec;
  const tokenized = genres.map(normalizeGenreString);
  for (let i = 0; i < GENRE_SLOT_DEFS.length; i++) {
    const def = GENRE_SLOT_DEFS[i];
    if (!def) continue;
    if (tokenized.some((tks) => tagMatchedKeyword(tks, def) !== null)) {
      vec[i] = 1;
    }
  }
  return vec;
}

/**
 * Pick a single canonical primary genre slot for a track. Most-specific
 * (longest matching keyword) wins; ties broken by slot order. Returns the
 * normalized first raw genre tag if no slot matches; null if input is empty.
 */
export function derivePrimaryGenre(genres: readonly string[]): string | null {
  if (genres.length === 0) return null;
  const tokenized = genres.map(normalizeGenreString);
  let best: { slot: string; len: number } | null = null;
  for (const def of GENRE_SLOT_DEFS) {
    for (const tks of tokenized) {
      const kw = tagMatchedKeyword(tks, def);
      if (kw !== null && (!best || kw.length > best.len)) best = { slot: def.slot, len: kw.length };
    }
  }
  if (best) return best.slot;
  for (const tks of tokenized) {
    if (tks.length > 0) return tks.join(" ");
  }
  return null;
}

/** Compose the full 64-dim embedding from audio features + genre tags. */
export function buildEmbedding(input: {
  audioFeatures: AudioFeatures | null;
  genres: readonly string[];
}): number[] {
  return [...audioFeaturesToVector(input.audioFeatures), ...genresToHotVector(input.genres)];
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 if either side is the zero vector
 * — used by callers that treat that case as "no similarity signal."
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  return weightedCosine(a, b, 1);
}

/**
 * LAB-36 — cosine with the audio dims (0..AUDIO_FEATURE_DIM-1) of BOTH
 * vectors scaled by `audioWeight` before the dot product. The 6 audio dims
 * carry ~9% of the embedding mass against 58 genre slots; weighting them up
 * at comparison time lets audio pull tracks across genre lanes WITHOUT
 * re-embedding — stored vectors are untouched, so historical replay stays
 * exact. `audioWeight=1` reduces EXACTLY to plain cosine (`x * 1 === x` in
 * IEEE 754 — pinned by test), which is what keeps legacy `{lambda}`-only
 * refill configs byte-identical on replay.
 *
 * LAB-48 — `audioWeight=0` is the other endpoint: scaling both vectors' audio
 * dims by 0 zeroes those dims in the dot product AND in both norms (the loop
 * accumulates `ai*ai`/`bi*bi` from the already-scaled values), so the metric
 * reduces to a pure genre-only cosine. {@link genreOnlyCosine} names this path
 * — it lets a track lacking audio features be compared on genre alone instead
 * of being made spuriously similar by the neutral 0.5 fills.
 */
export function weightedCosine(
  a: readonly number[],
  b: readonly number[],
  audioWeight: number,
): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const w = i < AUDIO_FEATURE_DIM ? audioWeight : 1;
    const ai = (a[i] ?? 0) * w;
    const bi = (b[i] ?? 0) * w;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * LAB-48 — cosine over the genre dims only: the 6-dim audio block is excluded
 * (`weightedCosine` at weight 0 zeroes it in both the dot product and both
 * norms) so a track lacking audio features is not made spuriously similar by
 * the neutral 0.5 fills `audioFeaturesToVector(null)` produces.
 */
export function genreOnlyCosine(a: readonly number[], b: readonly number[]): number {
  return weightedCosine(a, b, 0);
}

/**
 * LAB-36 — genre-mass threshold for {@link genreSlotsFromVector}. A bucket
 * centroid is a running mean of member multi-hot vectors, so one member out
 * of N contributes 1/N to its slots; any strictly positive mass means "some
 * member carries this slot". The epsilon only guards float32 noise from
 * pgvector round-trips.
 */
export const GENRE_MASS_EPSILON = 1e-6;

/**
 * LAB-36 — the set of genre-slot indices (0-based into GENRE_SLOTS) with
 * mass > epsilon in a full embedding/centroid vector. Track embeddings yield
 * their exact multi-hot slots; bucket centroids yield every slot ANY member
 * contributed — the order-insensitive bucket side of the slot-overlap gate.
 */
export function genreSlotsFromVector(
  vec: readonly number[],
  epsilon: number = GENRE_MASS_EPSILON,
): Set<number> {
  const slots = new Set<number>();
  for (let i = 0; i < GENRE_DIM; i++) {
    if ((vec[AUDIO_FEATURE_DIM + i] ?? 0) > epsilon) slots.add(i);
  }
  return slots;
}

/** True iff the two slot sets share at least one slot. */
export function hasSlotOverlap(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) {
    if (large.has(s)) return true;
  }
  return false;
}

export const ZERO_AUDIO: AudioFeatures = {
  tempo: 0,
  energy: 0,
  valence: 0,
  danceability: 0,
  acousticness: 0,
  instrumentalness: 0,
};
