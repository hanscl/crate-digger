import type { SourceAdapter } from "./adapter";
import { fetchPlaylistTrackItems, spotifyAdapter, spotifyTrackToCandidate } from "./spotify";
import type { RawCandidate } from "./types";

/**
 * LAB-84 — playlist-seed adapter: an interim TikTok-velocity STOPGAP, NOT a
 * velocity source (the real one, LAB-19, stays open). It pulls tracks from
 * curated Spotify playlists (the configured
 * `app_config.sources.tiktokPlaylistSeed.playlistIds`) as EXPLORE-LANE
 * CANDIDATES — provenance `tiktok-playlist-seed`, zero presumption of like.
 *
 * They flow through the SAME plumbing as any source (resolve → enrich → embed →
 * surface); the only difference is the terminal: the surfacing candidate pool,
 * never the cold-start keep path (`assignTrack`), which would bucket-as-keep and
 * contaminate the taste model off mainstream pop. The mainstream skew is handled
 * downstream by the inverse-popularity surfacing bias, not here — this adapter
 * ingests the whole playlist (capped at 2000) and lets surfacing throttle what
 * reaches the user (Constraint #5).
 *
 * Reuses the Spotify client (no dedicated key), so `isAvailable` mirrors the
 * Spotify adapter. Playlist IDs arrive via `params.playlistIds`: the pipeline
 * reads them from config and passes them in. A bare `mode: "trending"` with no
 * IDs returns [] — the generic trending sweep never drives this adapter (it's
 * handled by a dedicated pass in `pullAndEnrichTrending`).
 */
export const playlistSeedAdapter: SourceAdapter = {
  id: "tiktok-playlist-seed",
  isPaid: false,
  isAvailable(env) {
    return spotifyAdapter.isAvailable(env);
  },
  async pullCandidates(params, env) {
    // Playlist-seed only ingests configured playlists; search/similar are no-ops.
    if (params.mode !== "trending") return [];
    const playlistIds = params.playlistIds ?? [];
    if (playlistIds.length === 0 || !this.isAvailable(env)) return [];
    try {
      const out: RawCandidate[] = [];
      for (const playlistId of playlistIds) {
        const tracks = await fetchPlaylistTrackItems(playlistId, env);
        // Reuse the Spotify mapper (carries spotifyId + popularity), then stamp
        // the playlist-seed provenance so eval can measure keep-rate by source.
        for (const t of tracks) {
          out.push({ ...spotifyTrackToCandidate(t), source: "tiktok-playlist-seed" });
        }
      }
      return out;
    } catch (err) {
      console.error("[playlist-seed] pullCandidates threw — degrading to []", err);
      return [];
    }
  },
};
