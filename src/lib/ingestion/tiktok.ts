import type { Env } from "@/server/env";
import type { SourceAdapter } from "./adapter";
import { chartmetricProvider } from "./chartmetric";
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
 * Provider precedence (the first configured one wins):
 *   1. Chartmetric — usage-based (~$0.01/credit, free trial); the default for
 *      a single-user install.
 *   2. Soundcharts — $250/mo floor, but live-verified; the reference / fallback.
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

/** Provider precedence: the first configured one wins (Chartmetric preferred on cost). */
const PROVIDERS: readonly TikTokTrendingProvider[] = [chartmetricProvider, soundchartsProvider];

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
