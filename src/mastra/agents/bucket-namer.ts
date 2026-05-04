import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { Env } from "@/server/env";

/**
 * Bucket-namer agent. One call per spawned bucket. Given the bucket's primary
 * genre and a few sample tracks, returns a short human-readable name and a
 * hex color so the dashboard can display it as a colored shelf. The agent
 * runs on `claude-haiku-4-5` because the task is short and naming quality
 * matters less than throughput at scale; bumping to Sonnet is a one-line
 * change if eval shows otherwise.
 *
 * Constraint #4 / Constraint #7 do not apply here — naming is purely
 * cosmetic. If the agent fails (no API key, network error) we fall back to
 * the deterministic placeholder used by `assignTrack` so the bucket is
 * never left in a half-named state.
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
    .describe("Hex color in #rrggbb form that loosely evokes the genre's mood."),
});

export type BucketName = z.infer<typeof NAME_SCHEMA>;

export type BucketNamerInput = {
  primaryGenre: string | null;
  sampleTracks: { title: string; artist: string }[];
};

const INSTRUCTIONS = `You name buckets in a personal music-discovery library.

A bucket holds tracks the user has clustered around a shared sound. You will
receive the bucket's primary genre and 3–10 representative tracks. Pick a
short, evocative name (2–4 words, title case) and a single hex color that
loosely evokes the genre's mood.

Avoid:
- Generic words like "Mix", "Playlist", "Collection".
- Verbatim copies of the genre tag.
- Quotes, emoji, or trailing punctuation.

Return ONLY the structured object — no commentary.`;

export const bucketNamerAgent = new Agent({
  id: "bucket-namer",
  name: "Bucket Namer",
  instructions: INSTRUCTIONS,
  model: "anthropic/claude-haiku-4-5",
});

const FALLBACK_COLOR = "#22d3ee"; // matches `tokens.css` accent

function fallbackName(input: BucketNamerInput): BucketName {
  const base = input.primaryGenre
    ? input.primaryGenre.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "Unnamed";
  return { name: `${base} (auto)`, color: FALLBACK_COLOR };
}

function buildPrompt(input: BucketNamerInput): string {
  const lines = input.sampleTracks
    .slice(0, 10)
    .map((t, i) => `${i + 1}. ${t.title} — ${t.artist}`)
    .join("\n");
  const genreLine = input.primaryGenre ?? "(no primary genre)";
  return `Primary genre: ${genreLine}\n\nSample tracks:\n${lines}`;
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
    const result = await bucketNamerAgent.generate(buildPrompt(input), {
      structuredOutput: { schema: NAME_SCHEMA },
    });
    return NAME_SCHEMA.parse(result.object);
  } catch (err) {
    console.error("[bucket-namer] failed, using fallback", err);
    return fallbackName(input);
  }
}
