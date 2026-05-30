import { createAnthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { AudioFeatures } from "@/db/schema";
import type { Env } from "@/server/env";

/**
 * Bucket-namer agent. Given a bucket's aggregate character — member-genre
 * distribution, centroid audio profile, and a handful of sample tracks —
 * returns a short human-readable name and a hex color so the dashboard can
 * display it as a colored shelf. The agent runs on `claude-haiku-4-5` because
 * the task is short and naming quality matters less than throughput at scale.
 *
 * LAB-25: input is the *aggregate* shape of the bucket, not the founding
 * track's genre. The agent is instructed explicitly to name from the shared
 * character of the members, sidestepping the artist-genre-dominated tagging
 * we get from Last.fm.
 *
 * Constraint #4 / Constraint #7 / Constraint #3 do not apply — naming is
 * purely cosmetic and orthogonal to ranking. If the agent fails (no API key,
 * network error) we fall back to a deterministic placeholder so the bucket
 * is never left in a half-named state.
 */

export const NAME_SCHEMA = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .describe("Short, human-readable bucket name. Two to four words. Title case."),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .describe("Hex color in #rrggbb form that loosely evokes the cluster's mood."),
});

export type BucketName = z.infer<typeof NAME_SCHEMA>;

export type GenreCount = { genre: string; count: number };

export type BucketNamerInput = {
  /** Informational; the agent should NOT name solely from this. */
  primaryGenre: string | null;
  memberCount: number;
  /** Aggregated across `track.genres[]` of every member. Top entries first. */
  genreDistribution: GenreCount[];
  /** The bucket's centroid audio profile — `bucket.featureStats.mean`. */
  audioProfile: AudioFeatures;
  sampleTracks: { title: string; artist: string }[];
};

const INSTRUCTIONS = `You name buckets in a personal music-discovery library.

A bucket holds tracks the user has clustered around a shared sound. You will
receive:
- The bucket's aggregated member-genre distribution (across all tracks).
- The bucket's centroid audio profile across six perceptual features.
- A handful of representative tracks.

Name the bucket from the SHARED CHARACTER of the members — not any single
genre tag and not any single track. A cluster whose centroid is low-energy,
high-acousticness should be named for what those numbers mean ("Acoustic
Ballads"), even if the genre tags say "metal" or "rock". A cluster whose
centroid is high-energy and high-danceability is some flavour of "Dance" or
"Energetic", even if the tags scatter across pop, electronic, and house.

Audio-feature hints (each 0–1 except tempo which is BPM):
- tempo: >130 = up-tempo, 90–130 = mid, <90 = slow.
- energy: high = energetic / loud, low = mellow / quiet.
- valence: high = upbeat / happy, low = sombre / melancholic.
- danceability: high = danceable / rhythmic.
- acousticness: high = acoustic / unplugged, low = electric / produced.
- instrumentalness: high = instrumental, low = vocal-led.

Output rules:
- Two to four words, title case.
- Avoid generic words like "Mix", "Playlist", "Collection".
- Avoid verbatim copies of any single genre tag.
- No quotes, emoji, or trailing punctuation.
- Color: a single hex #rrggbb that loosely evokes the cluster's mood.

Return ONLY the structured object — no commentary.`;

export const bucketNamerAgent = new Agent({
  id: "bucket-namer",
  name: "Bucket Namer",
  instructions: INSTRUCTIONS,
  model: "anthropic/claude-haiku-4-5",
});

const FALLBACK_COLOR = "#22d3ee"; // matches `tokens.css` accent
const FALLBACK_SUFFIX = " (auto)";
const NAME_MAX = 40;

/** Pick the most prominent genre tag from `(primaryGenre, genreDistribution)`. */
function topGenre(input: BucketNamerInput): string | null {
  if (input.primaryGenre) return input.primaryGenre;
  const top = input.genreDistribution[0];
  return top ? top.genre : null;
}

function fallbackName(input: BucketNamerInput): BucketName {
  const seed = topGenre(input);
  const base = seed
    ? seed.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "Unnamed";
  const truncated = base.slice(0, NAME_MAX - FALLBACK_SUFFIX.length).trimEnd();
  return NAME_SCHEMA.parse({ name: `${truncated}${FALLBACK_SUFFIX}`, color: FALLBACK_COLOR });
}

function formatGenreDistribution(dist: GenreCount[]): string {
  if (dist.length === 0) return "(none)";
  return dist
    .slice(0, 10)
    .map((g) => `${g.genre} (${g.count})`)
    .join(", ");
}

function formatAudioProfile(p: AudioFeatures): string {
  // Tempo as integer BPM; the rest to two decimals so the LLM doesn't anchor
  // on spurious precision.
  return [
    `tempo ${Math.round(p.tempo)} BPM`,
    `energy ${p.energy.toFixed(2)}`,
    `valence ${p.valence.toFixed(2)}`,
    `danceability ${p.danceability.toFixed(2)}`,
    `acousticness ${p.acousticness.toFixed(2)}`,
    `instrumentalness ${p.instrumentalness.toFixed(2)}`,
  ].join(", ");
}

function buildPrompt(input: BucketNamerInput): string {
  const sampleLines = input.sampleTracks
    .slice(0, 10)
    .map((t, i) => `${i + 1}. ${t.title} — ${t.artist}`)
    .join("\n");
  return [
    `Member count: ${input.memberCount}`,
    `Genre distribution: ${formatGenreDistribution(input.genreDistribution)}`,
    `Centroid audio profile: ${formatAudioProfile(input.audioProfile)}`,
    "",
    "Sample tracks:",
    sampleLines || "(no samples)",
  ].join("\n");
}

/**
 * Run the bucket-namer agent. Falls back to a deterministic name when the
 * Anthropic API key is unset or the call fails — the bucket always gets a
 * usable name. Errors are logged and swallowed: a naming hiccup must never
 * fail the surrounding bucketing transaction.
 */
export async function nameBucket(input: BucketNamerInput, env: Env): Promise<BucketName> {
  if (!env.ANTHROPIC_API_KEY) return fallbackName(input);
  try {
    // Bind the apiKey from `env` to the SDK so the gate above and the actual
    // call agree on a single source of truth (the module-scope agent above
    // is registered for Mastra Studio and reads `process.env`).
    const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })("claude-haiku-4-5");
    const agent = new Agent({
      id: "bucket-namer",
      name: "Bucket Namer",
      instructions: INSTRUCTIONS,
      model,
    });
    const result = await agent.generate(buildPrompt(input), {
      structuredOutput: { schema: NAME_SCHEMA },
    });
    return NAME_SCHEMA.parse(result.object);
  } catch (err) {
    console.error("[bucket-namer] failed, using fallback", err);
    return fallbackName(input);
  }
}
