import { describe, expect, it } from "vitest";
import {
  BREAKOUT_BALANCE,
  computeBreakout,
  toBreakout,
  UNKNOWN_MATURITY,
} from "@/lib/ingestion/chartmetric/breakout";
import type { BreakoutSignals } from "@/lib/ingestion/chartmetric/types";

/**
 * Pure breakout-scoring unit tests for the Chartmetric engine (LAB-117 +
 * LAB-91). Mirrors `viberate-breakout.test.ts`: a high-social / low-maturity
 * track must outrank a mainstream one, and — the LAB-91 fix — a track with NO
 * maturity signal must be discounted (neutral imputation), not scored as if it
 * were maximally obscure.
 */

describe("chartmetric computeBreakout", () => {
  it("scores high social + low Spotify above high social + high Spotify (the gap)", () => {
    const breaking: BreakoutSignals = { shazamCount: 40_000, spotifyPopularity: 8 };
    const mainstream: BreakoutSignals = { shazamCount: 40_000, spotifyPopularity: 90 };

    const b = computeBreakout(breaking);
    const m = computeBreakout(mainstream);

    expect(b.socialMomentum).toBeCloseTo(m.socialMomentum, 5); // same social signal
    expect(b.spotifyMaturity).toBeLessThan(m.spotifyMaturity);
    expect(b.score).toBeGreaterThan(m.score);
  });

  it("imputes UNKNOWN_MATURITY when no maturity signal is present (LAB-91)", () => {
    // The live PinkPantheress case: 1.5M Shazams, null popularity, no resolve hop.
    // Before the fix this scored ~1.0 (absence treated as 0 maturity).
    const noMaturity = computeBreakout({ shazamCount: 1_500_000 });
    expect(noMaturity.spotifyMaturity).toBe(UNKNOWN_MATURITY);
    expect(noMaturity.score).toBeCloseTo(
      noMaturity.socialMomentum - BREAKOUT_BALANCE * UNKNOWN_MATURITY,
      5,
    );

    // A genuine obscure find (present-but-low popularity) must now outrank it.
    const knownObscure = computeBreakout({ shazamCount: 1_500_000, spotifyPopularity: 5 });
    expect(knownObscure.spotifyMaturity).toBeLessThan(UNKNOWN_MATURITY);
    expect(knownObscure.score).toBeGreaterThan(noMaturity.score);
  });

  it("treats a present-but-zero popularity as KNOWN-low, not unknown", () => {
    const b = computeBreakout({ tiktokPosts: 80_000, spotifyPopularity: 0 });
    expect(b.spotifyMaturity).toBe(0); // known zero ⇒ no discount
    expect(b.score).toBeCloseTo(b.socialMomentum, 5);
  });

  it("never hard-zeros a mainstream track (Balanced) and stays in [0,1]", () => {
    const mega = computeBreakout({
      shazamCount: 1_000_000,
      spotifyPopularity: 100,
      spotifyTotalStreams: 500_000_000,
      spotifyPlaylistReach: 50_000_000,
    });
    expect(mega.score).toBeGreaterThanOrEqual(0);
    expect(mega.score).toBeLessThanOrEqual(1);
    expect(mega.spotifyMaturity).toBeGreaterThan(0.9);
    expect(mega.score).toBeGreaterThan(0); // discounted, not vetoed
  });

  it("toBreakout packages provider/feed with the computed score", () => {
    const b = toBreakout({ shazamCount: 40_000, spotifyPopularity: 10 }, "shazam");
    expect(b.provider).toBe("chartmetric");
    expect(b.feed).toBe("shazam");
    expect(b.score).toBeGreaterThan(0);
  });
});
