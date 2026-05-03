import type { SourceAdapter } from "./adapter";

/**
 * Viberate is a paid trend-data source. Constraint #1: paid sources are
 * optional — the system runs fully on Spotify + Last.fm. Until we add
 * real coverage, this adapter conforms to the interface, reports
 * unavailable without a key, and degrades to an empty pool.
 */
export const viberateAdapter: SourceAdapter = {
  id: "viberate",
  isPaid: true,
  isAvailable(env) {
    return env.VIBERATE_API_KEY.length > 0;
  },
  async pullCandidates() {
    return [];
  },
};
