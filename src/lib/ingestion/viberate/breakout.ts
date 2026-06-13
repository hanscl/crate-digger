/**
 * Breakout scoring (LAB-90) — pure, deterministic, unit-testable.
 *
 * Core objective: escape the popular-playlist tail. The top of every chart is
 * mainstream, so "trending" alone isn't the signal. The signal is DIVERGENCE —
 * high social/alternative momentum (Shazam, SoundCloud, YouTube, intra-Spotify
 * surge %) while Spotify *maturity* (absolute streams, playlist reach) is still
 * LOW. We score that gap and compose the pull toward it.
 *
 *   score = clamp01( socialMomentum − BALANCE · spotifyMaturity )
 *
 * BALANCE < 1 makes maturity a discount, not a veto — the "Balanced" setting
 * Hans chose (down-weight the mainstream, never hard-exclude it; Constraint #4).
 * Raw provider counts are heavy-tailed, so each is mapped through a saturating
 * log curve against a reference "this is a big number" anchor.
 */

import type { BreakoutSignals, ChartTimeframes, ViberateBreakout, ViberateFeed } from "./types";

/** Maturity discount weight. Balanced ⇒ mainstream is penalized, not excluded. */
export const BREAKOUT_BALANCE = 0.6;

/**
 * Feed selection weights. The Spotify-trending feed is Spotify-native by
 * definition, so it's de-emphasized in pull composition to keep the pool from
 * collapsing back into the Spotify short tail — without dropping it entirely.
 */
export const FEED_WEIGHTS: Record<ViberateFeed, number> = {
  "composite-chart": 1.0,
  "youtube-trending": 0.9,
  "spotify-trending": 0.45,
};

/** Log-saturation anchors (the value that maps to ~1.0). Tunable. */
const REF = {
  shazam: 20_000,
  soundcloud: 500_000,
  youtubeWeek: 1_000_000,
  spotifyTotal: 20_000_000,
  /** Weekly Spotify streams anchor (~7× the daily one). */
  spotifyWeek: 14_000_000,
  spotifyDay: 2_000_000,
  playlistReach: 10_000_000,
  /** A percentage surge; 500% w/w is already a strong breakout. */
  pct: 500,
} as const;

/** Coerce an unknown (Viberate returns some totals as strings) to a finite number or null. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Saturating log map: 0 at value≤0, → 1 as value → ref and beyond. */
function sat(value: number | null | undefined, ref: number): number {
  const v = num(value);
  if (v === null || v <= 0) return 0;
  return clamp01(Math.log1p(v) / Math.log1p(ref));
}

/** Probabilistic OR — multiple positive signals reinforce without exceeding 1. */
function orCombine(...xs: number[]): number {
  return clamp01(1 - xs.reduce((acc, x) => acc * (1 - clamp01(x)), 1));
}

/** Prefer the most recent populated timeframe bucket (1w → 1m → total). */
export function pickRecent(tf: ChartTimeframes | null | undefined): number | null {
  if (!tf) return null;
  return num(tf["1w"]) ?? num(tf["1m"]) ?? num(tf.total);
}

/**
 * Compute the breakout score from a candidate's gathered signals. Feed-aware:
 * the Spotify-trending feed has no social channel, so its intra-Spotify surge %
 * stands in as the "rising" momentum while absolute daily streams stand in for
 * maturity — letting low-base Spotify risers through but discounting megahits.
 */
export function computeBreakout(
  signals: BreakoutSignals,
  feed: ViberateFeed,
): Pick<ViberateBreakout, "score" | "socialMomentum" | "spotifyMaturity"> {
  let socialMomentum: number;
  if (feed === "spotify-trending") {
    // No social channel on this feed — the intra-Spotify surge % stands in as
    // the "rising" momentum (a low-base track surging hard is breakout-shaped).
    socialMomentum = sat(signals.spotifySurgePct, REF.pct);
  } else {
    socialMomentum = orCombine(
      sat(signals.shazam1w ?? signals.shazamTotal, REF.shazam),
      sat(signals.soundcloud1w ?? signals.soundcloudTotal, REF.soundcloud),
      orCombine(
        sat(signals.youtubeViews1w, REF.youtubeWeek),
        sat(signals.youtubeViewsPct, REF.pct),
      ),
    );
  }

  // Each Spotify-stream timeframe scored against its OWN anchor so a weekly
  // value isn't judged on the daily curve (which over-discounts breakouts).
  const spotifyMaturity = orCombine(
    sat(signals.spotifyStreamsTotal, REF.spotifyTotal),
    sat(signals.spotifyStreamsWeek, REF.spotifyWeek),
    sat(signals.spotifyStreamsDay, REF.spotifyDay),
    sat(signals.spotifyPlaylistReach, REF.playlistReach),
  );

  const score = clamp01(socialMomentum - BREAKOUT_BALANCE * spotifyMaturity);
  return { score, socialMomentum, spotifyMaturity };
}

/** Build the persisted breakout signal for `track_source.raw_payload`. */
export function toBreakout(signals: BreakoutSignals, feed: ViberateFeed): ViberateBreakout {
  return { provider: "viberate", feed, signals, ...computeBreakout(signals, feed) };
}

/** Selection ordering: breakout score weighted by feed, descending. */
export function selectionScore(b: ViberateBreakout): number {
  return b.score * (FEED_WEIGHTS[b.feed] ?? 1);
}

/**
 * Compose the per-run pull: keep the highest breakout-weighted candidates up to
 * the throttle `limit`. This is pull COMPOSITION (within the LAB-51 pull-size
 * throttle), not a surfacing filter — everything returned is still ingested in
 * full (Constraint #5). Stable: ties keep input order.
 */
export function selectTop<T extends { breakout: ViberateBreakout }>(
  scored: T[],
  limit: number,
): T[] {
  const n = Math.max(0, Math.floor(limit));
  return [...scored]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const d = selectionScore(b.item.breakout) - selectionScore(a.item.breakout);
      return d !== 0 ? d : a.index - b.index;
    })
    .slice(0, n)
    .map(({ item }) => item);
}
