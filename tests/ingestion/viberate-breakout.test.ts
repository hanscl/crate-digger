import { describe, expect, it } from "vitest";
import {
  BREAKOUT_BALANCE,
  computeBreakout,
  FEED_WEIGHTS,
  num,
  pickRecent,
  selectionScore,
  selectTop,
  toBreakout,
} from "@/lib/ingestion/viberate/breakout";
import type { BreakoutSignals, ViberateBreakout } from "@/lib/ingestion/viberate/types";

/**
 * Pure breakout-scoring unit tests (LAB-90). The core objective lives here:
 * a high social-momentum / low Spotify-maturity track must outrank a mainstream
 * one, and the Spotify-trending feed must be de-emphasized in selection.
 */

describe("num", () => {
  it("coerces numbers and numeric strings; rejects junk", () => {
    expect(num(42)).toBe(42);
    expect(num("526")).toBe(526);
    expect(num("1.5")).toBe(1.5);
    expect(num(Number.NaN)).toBeNull();
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
  });
});

describe("pickRecent", () => {
  it("prefers 1w, then 1m, then total; coerces string totals", () => {
    expect(pickRecent({ "1w": 10, "1m": 20, total: 30 })).toBe(10);
    expect(pickRecent({ "1w": 0, total: 30 })).toBe(0); // 0 is a real value
    expect(pickRecent({ "1m": 20, total: "30" })).toBe(20);
    expect(pickRecent({ total: "526" })).toBe(526);
    expect(pickRecent({})).toBeNull();
    expect(pickRecent(null)).toBeNull();
  });
});

describe("computeBreakout", () => {
  it("scores high social + low Spotify above high social + high Spotify (the gap)", () => {
    const breaking: BreakoutSignals = { shazam1w: 5000, spotifyStreamsTotal: 1_000 };
    const mainstream: BreakoutSignals = { shazam1w: 5000, spotifyStreamsTotal: 50_000_000 };

    const b = computeBreakout(breaking, "composite-chart");
    const m = computeBreakout(mainstream, "composite-chart");

    expect(b.socialMomentum).toBeCloseTo(m.socialMomentum, 5); // same social signal
    expect(b.spotifyMaturity).toBeLessThan(m.spotifyMaturity); // breaking is less mature
    expect(b.score).toBeGreaterThan(m.score); // ⇒ outranks the mainstream track
  });

  it("keeps scores in [0,1] and never hard-zeros a mainstream track (Balanced)", () => {
    const mega = computeBreakout(
      { shazam1w: 1_000_000, spotifyStreamsTotal: 500_000_000, spotifyPlaylistReach: 500_000_000 },
      "composite-chart",
    );
    expect(mega.score).toBeGreaterThanOrEqual(0);
    expect(mega.score).toBeLessThanOrEqual(1);
    // max maturity only discounts by BALANCE, so a huge-social megahit isn't zeroed.
    expect(mega.score).toBeGreaterThan(0);
    expect(mega.spotifyMaturity).toBeGreaterThan(0.9);
  });

  it("youtube feed scores from view momentum with neutral (0) maturity pre-resolution", () => {
    const b = computeBreakout(
      { youtubeViews1w: 800_000, youtubeViewsPct: 400 },
      "youtube-trending",
    );
    expect(b.socialMomentum).toBeGreaterThan(0.4);
    expect(b.spotifyMaturity).toBe(0); // no Spotify signal yet
    expect(b.score).toBeCloseTo(b.socialMomentum, 5);
  });

  it("spotify-trending: low-base surge beats high-absolute megahit", () => {
    const riser = computeBreakout(
      { spotifySurgePct: 400, spotifyStreamsDay: 5_000 },
      "spotify-trending",
    );
    const megahit = computeBreakout(
      { spotifySurgePct: 12, spotifyStreamsDay: 1_900_000 },
      "spotify-trending",
    );
    expect(riser.score).toBeGreaterThan(megahit.score);
  });

  it("applies the maturity discount with weight BREAKOUT_BALANCE", () => {
    // social only ⇒ score == socialMomentum; add full maturity ⇒ minus BALANCE.
    const socialOnly = computeBreakout({ shazam1w: 5_000 }, "composite-chart");
    const withMaturity = computeBreakout(
      { shazam1w: 5_000, spotifyStreamsTotal: 1_000_000_000, spotifyPlaylistReach: 1_000_000_000 },
      "composite-chart",
    );
    const drop = socialOnly.score - withMaturity.score;
    expect(drop).toBeCloseTo(BREAKOUT_BALANCE * withMaturity.spotifyMaturity, 5);
  });
});

describe("selection", () => {
  const mk = (feed: ViberateBreakout["feed"], score: number): { breakout: ViberateBreakout } => ({
    breakout: {
      provider: "viberate",
      feed,
      score,
      socialMomentum: score,
      spotifyMaturity: 0,
      signals: {},
    },
  });

  it("weights the Spotify-trending feed below composite at equal raw score", () => {
    expect(FEED_WEIGHTS["composite-chart"]).toBeGreaterThan(FEED_WEIGHTS["spotify-trending"]);
    expect(selectionScore(mk("composite-chart", 0.5).breakout)).toBeGreaterThan(
      selectionScore(mk("spotify-trending", 0.5).breakout),
    );
  });

  it("selectTop keeps the highest weighted breakouts up to the limit, stably", () => {
    const items = [
      mk("spotify-trending", 0.9), // 0.9*0.45 = 0.405
      mk("composite-chart", 0.5), // 0.5*1.0 = 0.5
      mk("youtube-trending", 0.6), // 0.6*0.9 = 0.54
      mk("composite-chart", 0.1), // 0.1
    ];
    const top2 = selectTop(items, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0]).toBe(items[2]); // youtube 0.54
    expect(top2[1]).toBe(items[1]); // composite 0.5
  });

  it("selectTop clamps the limit and never mutates input order", () => {
    const items = [mk("composite-chart", 0.3), mk("composite-chart", 0.8)];
    expect(selectTop(items, 0)).toEqual([]);
    expect(selectTop(items, 99)).toHaveLength(2);
    expect(items[0]!.breakout.score).toBe(0.3); // input untouched
  });
});

describe("toBreakout", () => {
  it("packages the signal with provider/feed and the computed score", () => {
    const b = toBreakout({ shazam1w: 5_000 }, "composite-chart");
    expect(b.provider).toBe("viberate");
    expect(b.feed).toBe("composite-chart");
    expect(b.signals).toEqual({ shazam1w: 5_000 });
    expect(b.score).toBeGreaterThan(0);
  });
});
