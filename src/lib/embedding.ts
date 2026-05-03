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
 * one track may set multiple slots (e.g. "indie rock" sets `rock` and `indie`).
 */
const GENRE_SLOT_DEFS: readonly { slot: string; keywords: readonly string[] }[] = [
  { slot: "rock", keywords: ["rock"] },
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

/** Multi-hot 58-dim genre vector. Each slot is 1 iff any input genre matches it. */
export function genresToHotVector(genres: readonly string[]): number[] {
  const vec: number[] = Array.from({ length: GENRE_DIM }, () => 0);
  if (genres.length === 0) return vec;
  const tokenized = genres.map(normalizeGenreString);
  for (let i = 0; i < GENRE_SLOT_DEFS.length; i++) {
    const def = GENRE_SLOT_DEFS[i];
    if (!def) continue;
    const kwTokens = def.keywords.map((k) => k.split(/\s+/));
    if (tokenized.some((tks) => kwTokens.some((kw) => tokensContain(tks, kw)))) {
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
    for (const kw of def.keywords) {
      const kwTokens = kw.split(/\s+/);
      if (tokenized.some((tks) => tokensContain(tks, kwTokens))) {
        if (!best || kw.length > best.len) best = { slot: def.slot, len: kw.length };
      }
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
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export const ZERO_AUDIO: AudioFeatures = {
  tempo: 0,
  energy: 0,
  valence: 0,
  danceability: 0,
  acousticness: 0,
  instrumentalness: 0,
};
