import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { type AudioFeatures, appConfig, track } from "@/db/schema";
import { createRateLimiter, fetchWithRetry } from "./rate-limit";

/**
 * ReccoBeats audio-features enrichment.
 *
 * Spotify retired `/audio-features` for any app registered after
 * 2024-11-27, so the audio half of the embedding can no longer come from
 * Spotify. ReccoBeats (https://reccobeats.com) is a free, no-auth API that
 * returns the same Spotify-shaped perceptual features keyed by Spotify
 * track id. This module is the replacement for the old `spotify-features.ts`.
 *
 * Caching: the `audio_features IS NULL` filter on the target query IS the
 * cache — once a track's features are written they are never refetched
 * (features don't change). Same idempotency contract as the old enricher.
 *
 * Rate limiting lives in `./rate-limit` — 2 req/s, batches of <=5 ids,
 * `Retry-After` honoured on 429.
 */

const RECCOBEATS_BASE = "https://api.reccobeats.com/v1";
/** Community field practice caps batches at ~5 Spotify ids per request. */
const RECCOBEATS_BATCH = 5;
/** Module-scoped so concurrent enrich runs still share the 2 req/s budget. */
const rateLimiter = createRateLimiter(500);

/**
 * One ReccoBeats audio-features entry. ReccoBeats returns the nine
 * Spotify-shaped perceptual features plus post-launch bonus fields
 * (`key`, `mode`, `isrc`). We map the six the 64-dim embedding uses;
 * `key`/`mode` are intentionally ignored (using them is an embedding-dim
 * change — out of scope), `isrc` is surfaced for an opportunistic backfill.
 */
type ReccoBeatsEntry = {
  id?: unknown;
  trackId?: unknown;
  href?: unknown;
  tempo?: unknown;
  energy?: unknown;
  valence?: unknown;
  danceability?: unknown;
  acousticness?: unknown;
  instrumentalness?: unknown;
  isrc?: unknown;
};

export type FetchedFeatures = AudioFeatures & { isrc: string | null };

/**
 * Fetch audio features for a set of Spotify track ids, returning a map
 * keyed by Spotify id. Tracks ReccoBeats has no data for are simply absent
 * from the map — that is a normal outcome (coverage for long-tail / indie
 * tracks is uncharacterised), not an error.
 *
 * ⚠️ The ReccoBeats response envelope is assumed, not verified against the
 * live API. `parseFeatureEntries` accepts the plausible shapes (bare array,
 * `{ content }`, `{ audioFeatures }`); `resolveSpotifyId` recovers the
 * Spotify id from `id`, `trackId`, or a `href` Spotify URL. Anything
 * unrecognised is skipped, so a shape mismatch degrades to "no features"
 * rather than crashing — re-confirm against the live API before relying on
 * coverage numbers.
 */
export async function fetchAudioFeatures(
  spotifyTrackIds: string[],
): Promise<Map<string, FetchedFeatures>> {
  const out = new Map<string, FetchedFeatures>();
  const unique = [...new Set(spotifyTrackIds.filter((id) => id.length > 0))];

  for (let i = 0; i < unique.length; i += RECCOBEATS_BATCH) {
    const chunk = unique.slice(i, i + RECCOBEATS_BATCH);
    const requested = new Set(chunk);
    // Spotify ids are Base62 (alphanumeric only), so no percent-encoding is
    // needed — the comma is the separator and must reach the API literally.
    const url = `${RECCOBEATS_BASE}/audio-features?ids=${chunk.join(",")}`;
    const res = await rateLimiter.schedule(() => fetchWithRetry(url, { method: "GET" }));
    if (!res) continue; // batch failed after retries — skip, the rest still run

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      console.error("[reccobeats] response was not valid JSON");
      continue;
    }

    for (const entry of parseFeatureEntries(json)) {
      const spotifyId = resolveSpotifyId(entry, requested);
      if (!spotifyId) continue;
      const features = toFeatures(entry);
      if (features) out.set(spotifyId, features);
    }
  }
  return out;
}

/** Walk the plausible ReccoBeats envelopes down to the entry array. */
function parseFeatureEntries(json: unknown): ReccoBeatsEntry[] {
  if (Array.isArray(json)) return json as ReccoBeatsEntry[];
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const key of ["content", "audioFeatures", "audio_features", "data"]) {
      if (Array.isArray(obj[key])) return obj[key] as ReccoBeatsEntry[];
    }
  }
  return [];
}

/** Recover the Spotify track id for an entry, restricted to the ids we asked for. */
function resolveSpotifyId(entry: ReccoBeatsEntry, requested: Set<string>): string | null {
  for (const candidate of [entry.id, entry.trackId]) {
    if (typeof candidate === "string" && requested.has(candidate)) return candidate;
  }
  if (typeof entry.href === "string") {
    const m = /\/track\/([A-Za-z0-9]+)/.exec(entry.href);
    if (m?.[1] && requested.has(m[1])) return m[1];
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Map a raw entry to the six embedding features; null if any is missing. */
function toFeatures(e: ReccoBeatsEntry): FetchedFeatures | null {
  const tempo = num(e.tempo);
  const energy = num(e.energy);
  const valence = num(e.valence);
  const danceability = num(e.danceability);
  const acousticness = num(e.acousticness);
  const instrumentalness = num(e.instrumentalness);
  if (
    tempo === null ||
    energy === null ||
    valence === null ||
    danceability === null ||
    acousticness === null ||
    instrumentalness === null
  ) {
    return null;
  }
  const isrc =
    typeof e.isrc === "string" && e.isrc.trim().length > 0 ? e.isrc.trim().toUpperCase() : null;
  return { tempo, energy, valence, danceability, acousticness, instrumentalness, isrc };
}

type EnrichTarget = { id: number; spotifyId: string | null; isrc: string | null };

/** True unless `app_config.sources_enabled.reccobeats` is explicitly false. */
async function isReccoBeatsEnabled(db: Database): Promise<boolean> {
  const [cfg] = await db
    .select({ sourcesEnabled: appConfig.sourcesEnabled })
    .from(appConfig)
    .limit(1);
  return cfg?.sourcesEnabled?.reccobeats !== false;
}

/**
 * Backfill `track.audio_features` from ReccoBeats for a specific set of
 * tracks. Idempotent: only acts on rows with a `spotify_id` and null
 * `audio_features`, so re-running is a no-op. ReccoBeats needs no API key.
 */
export async function enrichAudioFeaturesForTracks(
  db: Database,
  trackIds: readonly number[],
): Promise<{ updated: number; isrcBackfilled: number }> {
  if (trackIds.length === 0) return { updated: 0, isrcBackfilled: 0 };
  if (!(await isReccoBeatsEnabled(db))) return { updated: 0, isrcBackfilled: 0 };

  const targets = await db
    .select({ id: track.id, spotifyId: track.spotifyId, isrc: track.isrc })
    .from(track)
    .where(
      and(
        inArray(track.id, [...trackIds]),
        isNotNull(track.spotifyId),
        isNull(track.audioFeatures),
      ),
    );
  return applyEnrichment(db, targets);
}

/**
 * Backfill every track that has a `spotify_id` but no audio features yet.
 * Manual / one-off entry point — the daily pipeline uses the per-tracks
 * variant above.
 */
export async function enrichAudioFeatures(
  db: Database,
): Promise<{ requested: number; updated: number; isrcBackfilled: number }> {
  if (!(await isReccoBeatsEnabled(db))) return { requested: 0, updated: 0, isrcBackfilled: 0 };

  const targets = await db
    .select({ id: track.id, spotifyId: track.spotifyId, isrc: track.isrc })
    .from(track)
    .where(and(isNotNull(track.spotifyId), isNull(track.audioFeatures)));
  const result = await applyEnrichment(db, targets);
  return { requested: targets.length, ...result };
}

async function applyEnrichment(
  db: Database,
  targets: EnrichTarget[],
): Promise<{ updated: number; isrcBackfilled: number }> {
  if (targets.length === 0) return { updated: 0, isrcBackfilled: 0 };

  const spotifyIds = targets
    .map((t) => t.spotifyId)
    .filter((s): s is string => s !== null && s.length > 0);
  const features = await fetchAudioFeatures(spotifyIds);
  if (features.size === 0) return { updated: 0, isrcBackfilled: 0 };

  const featureUpdates: { id: number; features: AudioFeatures }[] = [];
  const isrcUpdates: { id: number; isrc: string }[] = [];
  for (const t of targets) {
    if (!t.spotifyId) continue;
    const f = features.get(t.spotifyId);
    if (!f) continue;
    const { isrc, ...audio } = f;
    featureUpdates.push({ id: t.id, features: audio });
    if (isrc && !t.isrc) isrcUpdates.push({ id: t.id, isrc });
  }

  await bulkUpdateAudioFeatures(db, featureUpdates);
  const isrcBackfilled = await backfillIsrc(db, isrcUpdates);
  return { updated: featureUpdates.length, isrcBackfilled };
}

/**
 * Apply `(id, features)` pairs in a single `UPDATE … SET audio_features =
 * CASE id WHEN … END WHERE id IN (…)` — the `inArray` filter guarantees
 * every row in scope matches a `WHEN`, so the `CASE` never nulls a row.
 */
async function bulkUpdateAudioFeatures(
  db: Database,
  updates: { id: number; features: AudioFeatures }[],
): Promise<void> {
  if (updates.length === 0) return;
  const cases = updates.map((u) => sql`WHEN ${u.id} THEN ${JSON.stringify(u.features)}::jsonb`);
  await db
    .update(track)
    .set({ audioFeatures: sql`CASE ${track.id} ${sql.join(cases, sql.raw(" "))} END` })
    .where(
      inArray(
        track.id,
        updates.map((u) => u.id),
      ),
    );
}

/**
 * Opportunistic ISRC backfill — fill `track.isrc` only where it is still
 * null. Widen-only, mirroring `resolve.ts`. The unique index on `track.isrc`
 * can collide if another row already owns the ISRC; that is swallowed
 * per-row since the backfill is best-effort.
 */
async function backfillIsrc(
  db: Database,
  updates: { id: number; isrc: string }[],
): Promise<number> {
  let backfilled = 0;
  for (const u of updates) {
    try {
      const rows = await db
        .update(track)
        .set({ isrc: u.isrc, updatedAt: sql`NOW()` })
        .where(and(eq(track.id, u.id), isNull(track.isrc)))
        .returning({ id: track.id });
      if (rows.length > 0) backfilled += 1;
    } catch (err) {
      console.warn(`[reccobeats] isrc backfill skipped for track ${u.id}`, err);
    }
  }
  return backfilled;
}
