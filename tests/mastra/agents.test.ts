import { describe, expect, it } from "vitest";
import { nameBucket } from "@/mastra/agents/bucket-namer";
import { parsePlaylistText } from "@/mastra/agents/playlist-parser";
import { explainWhySurfaced } from "@/mastra/agents/why-surfaced";
import type { Env } from "@/server/env";

/**
 * Agent-fallback unit tests. The agents are LLM transformers; integration
 * with the Anthropic API isn't tested here (no key in CI). What we DO
 * pin: every agent has a deterministic local fallback for the no-key /
 * network-error case so the rest of the pipeline never blocks on naming
 * or explanation.
 */

const noKeyEnv: Env = {
  DATABASE_URL: "postgres://localhost",
  ADMIN_PASSPHRASE: "test",
  ANTHROPIC_API_KEY: "",
  SPOTIFY_CLIENT_ID: "",
  SPOTIFY_CLIENT_SECRET: "",
  SPOTIFY_REDIRECT_URI: "http://localhost/cb",
  LASTFM_API_KEY: "",
  VIBERATE_API_KEY: "",
  PORT: 3000,
  NODE_ENV: "test",
};

describe("bucket-namer fallback", () => {
  it("uses the deterministic placeholder when ANTHROPIC_API_KEY is missing", async () => {
    const result = await nameBucket(
      {
        primaryGenre: "indie-rock",
        sampleTracks: [
          { title: "Track A", artist: "Artist A" },
          { title: "Track B", artist: "Artist B" },
        ],
      },
      noKeyEnv,
    );
    expect(result.name).toContain("Indie");
    expect(result.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("handles a null primary genre", async () => {
    const result = await nameBucket({ primaryGenre: null, sampleTracks: [] }, noKeyEnv);
    expect(result.name).toBe("Unnamed (auto)");
  });
});

describe("why-surfaced fallback", () => {
  it("produces a refill explanation that references the bucket name", async () => {
    const result = await explainWhySurfaced(
      {
        trackTitle: "Foo",
        trackArtist: "Bar",
        primaryGenre: "rock",
        rankerKind: "refill",
        bucketName: "Late-night drive",
        winnerScore: 0.812,
        subScores: { keepSim: 0.85, dislikeSim: 0.04 },
        poolSize: 50,
      },
      noKeyEnv,
    );
    expect(result.reason).toMatch(/Late-night drive/);
    expect(result.reason).toMatch(/0\.812/);
  });

  it("produces a broad-explore explanation when no bucket is involved", async () => {
    const result = await explainWhySurfaced(
      {
        trackTitle: "Foo",
        trackArtist: "Bar",
        primaryGenre: null,
        rankerKind: "broad",
        bucketName: null,
        winnerScore: 0.5,
        subScores: { p_keep: 0.5 },
        poolSize: 100,
      },
      noKeyEnv,
    );
    expect(result.reason).toMatch(/broad/i);
    expect(result.reason).toMatch(/100/);
  });
});

describe("playlist-parser fallback", () => {
  it("parses a numbered list with hyphen separators", async () => {
    const text = `1. The Cure - Just Like Heaven
2. Slowdive – Alison
3. My Bloody Valentine — Only Shallow`;
    const result = await parsePlaylistText(text, noKeyEnv);
    expect(result.tracks).toHaveLength(3);
    expect(result.tracks[0]).toEqual({ artist: "The Cure", title: "Just Like Heaven" });
    expect(result.tracks[1]).toEqual({ artist: "Slowdive", title: "Alison" });
    expect(result.tracks[2]).toEqual({ artist: "My Bloody Valentine", title: "Only Shallow" });
  });

  it("parses a 'by' separator", async () => {
    const result = await parsePlaylistText("Wonderwall by Oasis", noKeyEnv);
    expect(result.tracks).toEqual([{ artist: "Wonderwall", title: "Oasis" }]);
  });

  it("ignores blank and unparseable lines", async () => {
    const text = `\n\nJust a single line with no separator\nFoo - Bar\n  \n`;
    const result = await parsePlaylistText(text, noKeyEnv);
    expect(result.tracks).toEqual([{ artist: "Foo", title: "Bar" }]);
  });

  it("returns an empty list for empty input", async () => {
    const result = await parsePlaylistText("   \n  ", noKeyEnv);
    expect(result.tracks).toEqual([]);
  });
});
