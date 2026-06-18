import type { Env } from "@/server/env";
import type { SourceAdapter } from "./adapter";
import { soundchartsProvider } from "./soundcharts";
import type { RawCandidate } from "./types";

/**
 * TikTok-velocity source adapter (LAB-19).
 *
 * Surfaces tracks trending on TikTok as a first-class discovery signal. TikTok
 * velocity data is paid-only across vendors, so the adapter wraps each vendor
 * behind a thin internal `TikTokTrendingProvider` interface and selects one at
 * runtime by which credentials are present.
 *
 * Provider: Soundcharts (live-verified; $250/mo floor). Chartmetric was the
 * original default here, but LAB-117 promoted it to a full social-breakout
 * discovery engine (`ingestion/chartmetric/`) that subsumes the TikTok chart as
 * one feed — so it's no longer wired as a TikTok-velocity provider. (The retired
 * provider also called the wrong endpoint — `/charts/tiktok` 404s; the real path
 * is `/charts/tiktok/tracks` — and was never live-verified.)
 *
 * Constraint #1: paid + optional. With no provider configured the adapter
 * reports unavailable and the system runs unchanged on Spotify + Last.fm.
 */
export interface TikTokTrendingProvider {
  readonly id: string;
  /** True iff this provider has the credentials it needs. */
  isConfigured(env: Env): boolean;
  /** Pull up to `limit` trending tracks. MUST resolve, never reject. */
  pullTrending(limit: number, env: Env): Promise<RawCandidate[]>;
}

/** Soundcharts is the remaining TikTok-velocity provider (Chartmetric → LAB-117 engine). */
const PROVIDERS: readonly TikTokTrendingProvider[] = [soundchartsProvider];

function activeProvider(env: Env): TikTokTrendingProvider | undefined {
  return PROVIDERS.find((p) => p.isConfigured(env));
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

/** Coerce caller-supplied limit to a positive integer in [1, MAX_LIMIT]. */
function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(raw), MAX_LIMIT));
}

export const tiktokAdapter: SourceAdapter = {
  id: "tiktok",
  isPaid: true,
  isAvailable(env) {
    return activeProvider(env) !== undefined;
  },
  async pullCandidates(params, env) {
    const provider = activeProvider(env);
    if (!provider) return [];
    // Velocity is a chart/trending signal — "similar" and "search" don't map
    // onto a breakout chart, so they degrade to an empty pool.
    if (params.mode !== "trending") return [];
    try {
      return await provider.pullTrending(clampLimit(params.limit), env);
    } catch (err) {
      console.error("[tiktok] pullCandidates threw — degrading to []", err);
      return [];
    }
  },
};
