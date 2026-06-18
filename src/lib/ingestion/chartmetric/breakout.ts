/**
 * Breakout scoring (LAB-117) — pure, deterministic, unit-testable. Same model
 * as the Viberate engine (`viberate/breakout.ts`), so the A/B is apples-to-
 * apples: the signal is DIVERGENCE — high social/alternative momentum (Shazam,
 * TikTok, SoundCloud, chart velocity) while Spotify *maturity* (popularity,
 * streams, playlist reach) is still LOW.
 *
 *   score = clamp01( socialMomentum − BALANCE · spotifyMaturity )
 *
 * BALANCE < 1 makes maturity a discount, not a veto — the "Balanced" setting
 * (down-weight the mainstream, never hard-exclude it; Constraint #4). Raw
 * provider counts are heavy-tailed, so each maps through a saturating log curve
 * against a reference "this is a big number" anchor; `spotify_popularity` is
 * already a bounded 0–100 index, so it maps linearly.
 *
 * UNKNOWN maturity (LAB-91): a row with NO Spotify-maturity signal — `null`
 * inline popularity and no resolve hop — has no maturity evidence, which is not
 * the same as low maturity. Scoring absence as 0 let high-social mainstream hits
 * (e.g. PinkPantheress, 1.5M Shazams, null popularity) claim a perfect breakout.
 * So absence imputes a neutral `UNKNOWN_MATURITY` discount; a KNOWN-low signal
 * (present and near 0) is untouched and still scores high.
 */

import { FEEDS } from "./config";
import type { BreakoutSignals, ChartmetricBreakout, ChartmetricFeedId } from "./types";

/** Maturity discount weight. Balanced ⇒ mainstream is penalized, not excluded. */
export const BREAKOUT_BALANCE = 0.6;

/**
 * Neutral maturity imputed when a candidate carries NO Spotify-maturity signal
 * (null popularity + no resolve hop), so absence-of-evidence is a moderate
 * discount rather than evidence-of-obscurity. Matches the Viberate engine so the
 * A/B stays apples-to-apples. Tunable.
 */
export const UNKNOWN_MATURITY = 0.5;

/** Feed selection weights, derived from the FEEDS config (social > spotify). */
export const FEED_WEIGHTS: Record<ChartmetricFeedId, number> = {
  spotify: 0.45,
  shazam: 1.0,
  tiktok: 0.9,
  soundcloud: 1.0,
  applemusic: 0.45,
  ...Object.fromEntries(FEEDS.map((f) => [f.id, f.weight])),
} as Record<ChartmetricFeedId, number>;

/**
 * Log-saturation anchors (the raw value that maps to ~1.0). Set from the
 * magnitudes seen in the LAB-117 spike; tunable. `pct`-style indices aren't
 * used here — Chartmetric gives absolute counts + a bounded popularity.
 */
const REF = {
  shazam: 50_000,
  tiktokPosts: 100_000,
  soundcloud: 500_000,
  /** Chart `velocity` is a small rank-movement ratio (≈2.9 seen at #1). */
  velocity: 5,
  spotifyDay: 2_000_000,
  spotifyTotal: 20_000_000,
  playlistReach: 20_000_000,
} as const;

/** Coerce an unknown (Chartmetric returns some totals as strings) to a finite number or null. */
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

/** A bounded 0–100 index (spotify_popularity) → [0,1]. */
function index100(value: number | null | undefined): number {
  const v = num(value);
  if (v === null || v <= 0) return 0;
  return clamp01(v / 100);
}

/** Probabilistic OR — multiple positive signals reinforce without exceeding 1. */
function orCombine(...xs: number[]): number {
  return clamp01(1 - xs.reduce((acc, x) => acc * (1 - clamp01(x)), 1));
}

/**
 * Compute the breakout score from a candidate's gathered signals. No per-feed
 * branch is needed: a Spotify-regional row carries no social count, so its
 * `chartVelocity` (rank-movement) stands in as the rising momentum — a low-base
 * Spotify riser is breakout-shaped — while `spotify_popularity` / streams
 * discount the mainstream hits.
 */
export function computeBreakout(
  signals: BreakoutSignals,
): Pick<ChartmetricBreakout, "score" | "socialMomentum" | "spotifyMaturity"> {
  const socialMomentum = orCombine(
    sat(signals.shazamCount, REF.shazam),
    sat(signals.tiktokPosts, REF.tiktokPosts),
    sat(signals.soundcloudPlays, REF.soundcloud),
    sat(signals.chartVelocity, REF.velocity),
  );

  // Each Spotify maturity signal scored against its own anchor; the inline 0–100
  // popularity is the floor available on most rows, reach/streams refine it. With
  // no maturity signal at all (null popularity, unresolved), impute the neutral
  // UNKNOWN_MATURITY discount; a present-but-zero signal counts as KNOWN-low.
  const maturityKnown =
    num(signals.spotifyPopularity) !== null ||
    num(signals.spotifyDailyStreams) !== null ||
    num(signals.spotifyPlaylistReach) !== null ||
    num(signals.spotifyTotalStreams) !== null;
  const spotifyMaturity = maturityKnown
    ? orCombine(
        index100(signals.spotifyPopularity),
        sat(signals.spotifyDailyStreams, REF.spotifyDay),
        sat(signals.spotifyPlaylistReach, REF.playlistReach),
        sat(signals.spotifyTotalStreams, REF.spotifyTotal),
      )
    : UNKNOWN_MATURITY;

  const score = clamp01(socialMomentum - BREAKOUT_BALANCE * spotifyMaturity);
  return { score, socialMomentum, spotifyMaturity };
}

/** Build the persisted breakout signal for `track_source.raw_payload`. */
export function toBreakout(signals: BreakoutSignals, feed: ChartmetricFeedId): ChartmetricBreakout {
  return { provider: "chartmetric", feed, signals, ...computeBreakout(signals) };
}

/** Selection ordering: breakout score weighted by feed, descending. */
export function selectionScore(b: ChartmetricBreakout): number {
  return b.score * (FEED_WEIGHTS[b.feed] ?? 1);
}

/**
 * Compose the per-run pull: keep the highest breakout-weighted candidates up to
 * the throttle `limit`. Pull COMPOSITION within the LAB-51 pull-size throttle,
 * not a surfacing filter — everything returned is still ingested in full
 * (Constraint #5). Stable: ties keep input order.
 */
export function selectTop<T extends { breakout: ChartmetricBreakout }>(
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
