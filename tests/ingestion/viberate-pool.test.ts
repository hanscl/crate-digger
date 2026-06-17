import { describe, expect, it } from "vitest";
import { dedupePool } from "@/lib/ingestion/viberate/pool";
import type { BreakoutSignals, PooledRow, ViberateFeed } from "@/lib/ingestion/viberate/types";

/**
 * Cross-feed dedup + signal-union fold (LAB-90). The realistic case is a track
 * returned by two composite sorts (shazam + soundcloud) under the same uuid;
 * the keep-higher-feed-weight winner is exercised on an identity-less collision.
 */

function mkRow(feed: ViberateFeed, over: Partial<PooledRow> = {}): PooledRow {
  return {
    feed,
    title: "Song",
    artist: "Artist",
    artists: [{ name: "Artist" }],
    releaseYear: 2026,
    spotifyId: null,
    isrc: null,
    uuid: null,
    youtubeId: null,
    genres: [],
    signals: {},
    raw: {},
    ...over,
  };
}

describe("dedupePool", () => {
  it("merges two composite sightings of the same uuid, unioning their signals", () => {
    const shazamSort = mkRow("composite-chart", {
      uuid: "u1",
      signals: { shazam1w: 8_000 } satisfies BreakoutSignals,
    });
    const soundcloudSort = mkRow("composite-chart", {
      uuid: "u1",
      signals: { soundcloud1w: 300_000 } satisfies BreakoutSignals,
    });

    const out = dedupePool([shazamSort, soundcloudSort]);
    expect(out).toHaveLength(1);
    expect(out[0]!.signals.shazam1w).toBe(8_000);
    expect(out[0]!.signals.soundcloud1w).toBe(300_000); // folded in from the loser
  });

  it("keeps the higher-feed-weight row on an artist::title collision (composite > youtube)", () => {
    const youtube = mkRow("youtube-trending", { signals: { youtubeViews1w: 500_000 } });
    const composite = mkRow("composite-chart", { signals: { shazam1w: 5_000 } });

    // Same artist+title, no identity fields ⇒ both key on artistTitleKey.
    const out = dedupePool([youtube, composite]);
    expect(out).toHaveLength(1);
    expect(out[0]!.feed).toBe("composite-chart"); // higher feed weight wins
    expect(out[0]!.signals.shazam1w).toBe(5_000);
    expect(out[0]!.signals.youtubeViews1w).toBe(500_000); // loser's signal folded in
  });

  it("does not merge distinct tracks", () => {
    const a = mkRow("composite-chart", { uuid: "a", title: "A" });
    const b = mkRow("composite-chart", { uuid: "b", title: "B" });
    expect(dedupePool([a, b])).toHaveLength(2);
  });
});
