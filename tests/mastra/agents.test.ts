import { describe, expect, it } from "vitest";
import type { AudioFeatures } from "@/db/schema";
import { nameBucket } from "@/mastra/agents/bucket-namer";
import { parsePlaylistText } from "@/mastra/agents/playlist-parser";
import { buildPrompt, explainWhySurfaced } from "@/mastra/agents/why-surfaced";
import type { Env } from "@/server/env";

const NEUTRAL_AUDIO: AudioFeatures = {
  tempo: 120,
  energy: 0.5,
  valence: 0.5,
  danceability: 0.5,
  acousticness: 0.5,
  instrumentalness: 0,
};

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
  MUSICBRAINZ_CONTACT_EMAIL: "",
  DISCOGS_KEY: "",
  DISCOGS_SECRET: "",
  VIBERATE_API_KEY: "",
  VIBERATE_TRENDING_COUNTRY: "US",
  CHARTMETRIC_REFRESH_TOKEN: "",
  CHARTMETRIC_TIKTOK_COUNTRY: "US",
  SOUNDCHARTS_APP_ID: "",
  SOUNDCHARTS_API_KEY: "",
  SOUNDCHARTS_TIKTOK_CHART_SLUG: "tiktok-breakout-us",
  PORT: 3000,
  NODE_ENV: "test",
  CRON_DISABLED: "",
};

describe("bucket-namer fallback", () => {
  it("uses the deterministic placeholder when ANTHROPIC_API_KEY is missing", async () => {
    const result = await nameBucket(
      {
        primaryGenre: "indie-rock",
        memberCount: 3,
        genreDistribution: [
          { genre: "indie-rock", count: 2 },
          { genre: "alternative", count: 1 },
        ],
        audioProfile: NEUTRAL_AUDIO,
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
    const result = await nameBucket(
      {
        primaryGenre: null,
        memberCount: 0,
        genreDistribution: [],
        audioProfile: NEUTRAL_AUDIO,
        sampleTracks: [],
      },
      noKeyEnv,
    );
    expect(result.name).toBe("Unnamed (auto)");
  });

  it("truncates long primary genres so the fallback name fits the schema", async () => {
    const longGenre = "very-long-genre-name-that-exceeds-the-schema-limit";
    const result = await nameBucket(
      {
        primaryGenre: longGenre,
        memberCount: 0,
        genreDistribution: [],
        audioProfile: NEUTRAL_AUDIO,
        sampleTracks: [],
      },
      noKeyEnv,
    );
    expect(result.name.length).toBeLessThanOrEqual(40);
    expect(result.name.endsWith(" (auto)")).toBe(true);
  });

  it("falls back to the top of genreDistribution when primaryGenre is null", async () => {
    // The LAB-24 case: derivePrimaryGenre may be null or noisy, but the
    // aggregated member-genre distribution still has a clear top tag.
    const result = await nameBucket(
      {
        primaryGenre: null,
        memberCount: 4,
        genreDistribution: [
          { genre: "synth-pop", count: 3 },
          { genre: "new wave", count: 2 },
        ],
        audioProfile: NEUTRAL_AUDIO,
        sampleTracks: [],
      },
      noKeyEnv,
    );
    expect(result.name).toContain("Synth");
    expect(result.name.endsWith(" (auto)")).toBe(true);
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
        hasAudioFeatures: true,
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
        hasAudioFeatures: true,
      },
      noKeyEnv,
    );
    expect(result.reason).toMatch(/broad/i);
    expect(result.reason).toMatch(/100/);
  });

  it("audio-less track makes no sonic/audio claim", async () => {
    const result = await explainWhySurfaced(
      {
        trackTitle: "Foo",
        trackArtist: "Bar",
        primaryGenre: "indie",
        rankerKind: "refill",
        bucketName: "Indie picks",
        winnerScore: 0.7,
        subScores: { keepSim: 0.7 },
        poolSize: 30,
        hasAudioFeatures: false,
      },
      noKeyEnv,
    );
    expect(result.reason).not.toMatch(/sonic|acoustic|tempo|timbre|\benergy\b|\bsounds?\s+like\b/i);
  });
});

describe("why-surfaced buildPrompt", () => {
  const base = {
    trackTitle: "Foo",
    trackArtist: "Bar",
    primaryGenre: "indie",
    rankerKind: "refill" as const,
    bucketName: "Indie picks",
    winnerScore: 0.7,
    subScores: { keepSim: 0.7 },
    poolSize: 30,
  };

  it("steers the model off sonic claims when audio is absent", () => {
    const prompt = buildPrompt({ ...base, hasAudioFeatures: false });
    // Assert the FULL anchored line (not a bare substring), and that the
    // audio-present wording is absent — so the two branches are provably distinct.
    expect(prompt).toContain(
      "Audio features: ABSENT — do NOT claim any sonic/audio similarity; ground only in genre and bucket",
    );
    expect(prompt).not.toContain("available (you may reference sonic qualities)");
  });

  it("permits sonic references when audio is present", () => {
    const prompt = buildPrompt({ ...base, hasAudioFeatures: true });
    expect(prompt).toContain("Audio features: available (you may reference sonic qualities)");
    expect(prompt).not.toContain("ABSENT");
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

  it("parses a 'by' separator with title-first / artist-second convention", async () => {
    const result = await parsePlaylistText("Wonderwall by Oasis", noKeyEnv);
    expect(result.tracks).toEqual([{ artist: "Oasis", title: "Wonderwall" }]);
  });

  it("does not split hyphenated artist names", async () => {
    const result = await parsePlaylistText("Jay-Z - 99 Problems", noKeyEnv);
    expect(result.tracks).toEqual([{ artist: "Jay-Z", title: "99 Problems" }]);
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
