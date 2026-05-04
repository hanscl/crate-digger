import { createAnthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { Env } from "@/server/env";

/**
 * Cold-start helper: when the user pastes a free-text tracklist (e.g. from a
 * Reddit thread, a friend's email) the parser teases out artist/title pairs
 * we can pipe through `seedBucketsFromTrackIds`. The Spotify-playlist URL
 * path in `cold-start.ts` is the primary cold-start route; this agent is the
 * fallback for "I don't have a Spotify playlist, just a list."
 *
 * Deterministic fallback: a regex-based extractor that recognizes common
 * patterns (`Artist - Title`, `1. Artist – Title`, `Artist: Title`). Good
 * enough for clean inputs; the LLM is there for messy ones.
 */

export const PARSE_SCHEMA = z.object({
  tracks: z
    .array(
      z.object({
        artist: z.string().min(1).max(120),
        title: z.string().min(1).max(120),
      }),
    )
    .max(200),
});

export type ParsedPlaylist = z.infer<typeof PARSE_SCHEMA>;

const INSTRUCTIONS = `You extract artist/title pairs from a user-provided block of text.

The text might be a numbered list, a comma-separated dump, or copy-paste
from a webpage. Each entry in the input represents one track. Output
ONE structured object whose 'tracks' field contains every recognizable
artist/title pair, IN INPUT ORDER.

Rules:
- Strip leading numbering, bullets, and markdown.
- Trust the user's separator: "-", "–", "—", "by", or ":" all delimit
  artist from title. Pick whichever is consistent in the input.
- If a line has no recognizable artist/title pair, omit it.
- Do not invent tracks not present in the input.
- Cap at 200 entries.

Return ONLY the structured object — no commentary.`;

export const playlistParserAgent = new Agent({
  id: "playlist-parser",
  name: "Playlist Parser",
  instructions: INSTRUCTIONS,
  model: "anthropic/claude-haiku-4-5",
});

const DASH_COLON_RE = /\s*[-–—:]\s*/;
const BY_RE = /\s+by\s+/i;
const LEADING_RE = /^\s*(?:\d+[.)]\s*|[-*•]\s+)/;

function deterministicParse(raw: string): ParsedPlaylist {
  const tracks: { artist: string; title: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(LEADING_RE, "").trim();
    if (!cleaned) continue;
    // Dash/colon separators take precedence: "Artist - Title" is the dominant
    // convention. The "by" form ("Title by Artist") inverts the sides, so
    // detect which separator matched and assign accordingly.
    let left: string | undefined;
    let right: string | undefined;
    let separator: "dash" | "by" | null = null;
    const dashSplit = cleaned.split(DASH_COLON_RE);
    if (dashSplit.length >= 2) {
      left = dashSplit[0];
      right = dashSplit.slice(1).join(" - ");
      separator = "dash";
    } else {
      const bySplit = cleaned.split(BY_RE);
      if (bySplit.length >= 2) {
        left = bySplit[0];
        right = bySplit.slice(1).join(" by ");
        separator = "by";
      }
    }
    if (!separator) continue;
    const leftTrimmed = left?.trim();
    const rightTrimmed = right?.trim();
    if (!leftTrimmed || !rightTrimmed) continue;
    const [artist, title] =
      separator === "by" ? [rightTrimmed, leftTrimmed] : [leftTrimmed, rightTrimmed];
    tracks.push({ artist, title });
    if (tracks.length >= 200) break;
  }
  return { tracks };
}

export async function parsePlaylistText(raw: string, env: Env): Promise<ParsedPlaylist> {
  if (!raw.trim()) return { tracks: [] };
  if (!env.ANTHROPIC_API_KEY) return deterministicParse(raw);
  try {
    const model = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })("claude-haiku-4-5");
    const agent = new Agent({
      id: "playlist-parser",
      name: "Playlist Parser",
      instructions: INSTRUCTIONS,
      model,
    });
    const result = await agent.generate(raw, {
      structuredOutput: { schema: PARSE_SCHEMA },
    });
    return PARSE_SCHEMA.parse(result.object);
  } catch (err) {
    console.error("[playlist-parser] failed, falling back to regex", err);
    return deterministicParse(raw);
  }
}
