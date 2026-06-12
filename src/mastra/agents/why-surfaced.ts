import { createAnthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { CandidatePoolEntry } from "@/db/schema";
import type { Env } from "@/server/env";

/**
 * On-demand "why surfaced" explanation. The Queue screen calls this when the
 * user clicks the "?" on a surfaced track — the agent gets the structured
 * decision context (ranker kind, sub-scores, the bucket's identity if any)
 * and turns it into a one-sentence explanation in plain English.
 *
 * Deterministic fallback: when no API key is set we synthesize a terse
 * "ranked by <kind> with score X" line so the UI always has copy.
 */

export const EXPLANATION_SCHEMA = z.object({
  reason: z
    .string()
    .min(1)
    .max(220)
    .describe("One sentence, plain English, no quotes or trailing punctuation."),
});

export type Explanation = z.infer<typeof EXPLANATION_SCHEMA>;

export type WhySurfacedInput = {
  trackTitle: string;
  trackArtist: string;
  primaryGenre: string | null;
  rankerKind: "refill" | "broad";
  bucketName: string | null;
  /**
   * LAB-49: whether the track has real audio features; when false the
   * explanation must not claim sonic/audio similarity (no audio data to ground it).
   */
  hasAudioFeatures: boolean;
  /** Score the ranker assigned at decision time. */
  winnerScore: number;
  /** Sub-scores from the surface_event row — `keepSim`, `dislikeSim`, etc. */
  subScores: CandidatePoolEntry["subScores"];
  /** Compact summary of nearby losers ("ranked above N other candidates"). */
  poolSize: number;
};

const INSTRUCTIONS = `You explain to a single user why a particular track was just surfaced
to them by their personal music-discovery agent.

You will receive the structured decision context: which ranker chose the
track (refill = exploit, broad = explore), the winning score, sub-scores,
and (for refill) which bucket anchored the choice.

Ground every claim ONLY in the signals you are given. The context states
whether audio features are available. When audio features are ABSENT you MUST
NOT claim any sonic, audio, acoustic, energy, tempo, mood, or sounds-like
quality or similarity — there is no audio data to justify it; lean only on the
genre and the bucket. Reference sonic qualities ONLY when audio features are present.

Write ONE sentence. Plain English. No quotes. No emoji. No trailing
punctuation. Lead with the cause ("Because…", "Surfaced from…",
"Closest to your <bucket>…"). Mention the bucket by name when given.
For broad picks, frame it as exploration ("expanding your taste toward…").

Return ONLY the structured object — no commentary.`;

export const whySurfacedAgent = new Agent({
  id: "why-surfaced",
  name: "Why Surfaced",
  instructions: INSTRUCTIONS,
  model: "anthropic/claude-haiku-4-5",
});

// LAB-49: the fallback copy references only ranker/bucket/score metadata and
// deliberately never asserts sonic similarity, so it is safe for audio-less tracks.
function fallbackExplanation(input: WhySurfacedInput): Explanation {
  const score = input.winnerScore.toFixed(3);
  if (input.rankerKind === "refill" && input.bucketName) {
    return {
      reason: `Closest to your ${input.bucketName} bucket (refill score ${score})`,
    };
  }
  if (input.rankerKind === "refill") {
    return { reason: `Refilled from a saved bucket with score ${score}` };
  }
  return {
    reason: `Broad explore pick with classifier score ${score} across ${input.poolSize} candidates`,
  };
}

export function buildPrompt(input: WhySurfacedInput): string {
  const sub = input.subScores ?? {};
  const subLines = Object.entries(sub)
    .map(([k, v]) => `  - ${k}: ${typeof v === "number" ? v.toFixed(3) : String(v)}`)
    .join("\n");
  const audioLine = input.hasAudioFeatures
    ? "available (you may reference sonic qualities)"
    : "ABSENT — do NOT claim any sonic/audio similarity; ground only in genre and bucket";
  return `Track: ${input.trackTitle} — ${input.trackArtist}
Primary genre: ${input.primaryGenre ?? "(none)"}
Audio features: ${audioLine}
Ranker: ${input.rankerKind}
${input.bucketName ? `Anchor bucket: ${input.bucketName}` : "Anchor bucket: (none — broad)"}
Winner score: ${input.winnerScore.toFixed(3)}
Pool size: ${input.poolSize}
Sub-scores:
${subLines || "  (none)"}`;
}

export async function explainWhySurfaced(input: WhySurfacedInput, env: Env): Promise<Explanation> {
  if (!env.ANTHROPIC_API_KEY) return fallbackExplanation(input);
  try {
    const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })("claude-haiku-4-5");
    const agent = new Agent({
      id: "why-surfaced",
      name: "Why Surfaced",
      instructions: INSTRUCTIONS,
      model,
    });
    const result = await agent.generate(buildPrompt(input), {
      structuredOutput: { schema: EXPLANATION_SCHEMA },
    });
    return EXPLANATION_SCHEMA.parse(result.object);
  } catch (err) {
    console.error("[why-surfaced] failed, using fallback", err);
    return fallbackExplanation(input);
  }
}
