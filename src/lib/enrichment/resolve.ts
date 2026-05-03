import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { fuzzy } from "fast-fuzzy";
import type { Database } from "@/db/client";
import { track, trackSource } from "@/db/schema";
import type { RawCandidate } from "../ingestion/types";

/** Combined artist+title similarity (fast-fuzzy 0..1) above which we merge. */
export const FUZZY_THRESHOLD = 0.88;

export type MatchedBy = "isrc" | "spotifyId" | "fuzzy" | "inserted";

export type ResolveResult = {
  trackId: number;
  created: boolean;
  matchedBy: MatchedBy;
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/feat\.?\s+[^,&-]+/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fuzzyKey(c: { artist: string; title: string }): string {
  return `${normalize(c.artist)} :: ${normalize(c.title)}`;
}

/**
 * Resolve a `RawCandidate` to a `track` row. ISRC-first, Spotify-id second,
 * normalized-fuzzy third, insert fourth. Always upserts a `track_source` row
 * keyed on (source, source_track_id) so re-running with the same input is a
 * no-op at the row-count level (Phase 2 idempotency contract).
 */
export async function resolveCandidate(
  db: Database,
  candidate: RawCandidate,
): Promise<ResolveResult> {
  return db.transaction(async (tx) => {
    let resolved: { trackId: number; matchedBy: MatchedBy } | null = null;

    if (candidate.isrc) {
      const [hit] = await tx
        .select({ id: track.id })
        .from(track)
        .where(eq(track.isrc, candidate.isrc))
        .limit(1);
      if (hit) resolved = { trackId: hit.id, matchedBy: "isrc" };
    }

    if (!resolved && candidate.spotifyId) {
      const [hit] = await tx
        .select({ id: track.id })
        .from(track)
        .where(eq(track.spotifyId, candidate.spotifyId))
        .limit(1);
      if (hit) resolved = { trackId: hit.id, matchedBy: "spotifyId" };
    }

    if (!resolved) {
      // ISRC and spotify_id are strong identifiers: a candidate with one of
      // those must NOT fuzzy-merge into a row that already carries a *different*
      // value for the same field. (A remix and the original often share artist
      // and title but always have distinct ISRCs.) Rows with null in the field
      // are still eligible — that's how a Last.fm sighting gets enriched by a
      // later Spotify pull.
      const isrcGuard = candidate.isrc
        ? or(isNull(track.isrc), eq(track.isrc, candidate.isrc))
        : undefined;
      const spotifyGuard = candidate.spotifyId
        ? or(isNull(track.spotifyId), eq(track.spotifyId, candidate.spotifyId))
        : undefined;
      const guard = and(isrcGuard, spotifyGuard);

      // Coarse, indexed prefilter so we don't pull the entire `track` table
      // into the JS heap before fuzzy-matching. Last.fm candidates carry no
      // ISRC or spotify_id, so without this they would force a full scan on
      // every unresolved sighting. TODO: switch to `pg_trgm` GIN once the
      // catalog grows past ~10k rows — leading-prefix is cheap but coarse.
      const artistPrefix = normalize(candidate.artist).slice(0, 4);
      const prefilter =
        artistPrefix.length > 0 ? ilike(track.artist, `${artistPrefix}%`) : undefined;
      const where = and(guard, prefilter);

      const baseQuery = tx
        .select({ id: track.id, artist: track.artist, title: track.title })
        .from(track);
      const all = where ? await baseQuery.where(where) : await baseQuery.limit(500);

      const needle = fuzzyKey(candidate);
      let best: { id: number; score: number } | null = null;
      for (const row of all) {
        const score = fuzzy(needle, fuzzyKey(row));
        if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
          best = { id: row.id, score };
        }
      }
      if (best) resolved = { trackId: best.id, matchedBy: "fuzzy" };
    }

    let created = false;
    if (!resolved) {
      const [row] = await tx
        .insert(track)
        .values({
          isrc: candidate.isrc,
          spotifyId: candidate.spotifyId,
          title: candidate.title,
          artist: candidate.artist,
          album: candidate.album,
          releaseYear: candidate.releaseYear,
          durationMs: candidate.durationMs,
          genres: candidate.genres,
        })
        .returning({ id: track.id });
      if (!row) throw new Error("track insert returned no rows");
      resolved = { trackId: row.id, matchedBy: "inserted" };
      created = true;
    } else {
      // Widen-only backfill: fill nullable scalars only where the existing row is null.
      await tx
        .update(track)
        .set({
          isrc: sql`COALESCE(${track.isrc}, ${candidate.isrc})`,
          spotifyId: sql`COALESCE(${track.spotifyId}, ${candidate.spotifyId})`,
          album: sql`COALESCE(${track.album}, ${candidate.album})`,
          releaseYear: sql`COALESCE(${track.releaseYear}, ${candidate.releaseYear})`,
          durationMs: sql`COALESCE(${track.durationMs}, ${candidate.durationMs})`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(track.id, resolved.trackId));
    }

    await tx
      .insert(trackSource)
      .values({
        trackId: resolved.trackId,
        source: candidate.source,
        sourceTrackId: candidate.sourceTrackId,
        rawPayload: candidate.rawPayload,
      })
      .onConflictDoUpdate({
        target: [trackSource.source, trackSource.sourceTrackId],
        set: {
          trackId: resolved.trackId,
          seenAt: sql`NOW()`,
          rawPayload: candidate.rawPayload,
        },
      });

    return { trackId: resolved.trackId, created, matchedBy: resolved.matchedBy };
  });
}

/** Resolve a batch sequentially. Each call is its own transaction. */
export async function resolveCandidates(
  db: Database,
  candidates: readonly RawCandidate[],
): Promise<ResolveResult[]> {
  const results: ResolveResult[] = [];
  for (const c of candidates) {
    results.push(await resolveCandidate(db, c));
  }
  return results;
}
