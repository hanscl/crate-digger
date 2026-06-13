/** Small shared field-normalizers for the Viberate engine. */

import type { ViberateArtist } from "./types";

/** Uppercased, trimmed ISRC; null when absent/blank. */
export function normalizeIsrc(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return v.length > 0 ? v : null;
}

/** Year from an ISO date string (slice, not Date, to avoid TZ drift). */
export function parseReleaseYear(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.length < 4) return null;
  const year = Number.parseInt(raw.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

/** Primary-artist-first credit string from the artists array. */
export function joinArtists(artists: ViberateArtist[] | null | undefined): string {
  if (!Array.isArray(artists)) return "";
  return artists
    .map((a) => (typeof a?.name === "string" ? a.name.trim() : ""))
    .filter((n) => n.length > 0)
    .join(", ");
}

/** Normalized dedup key: lowercased "artist::title". */
export function artistTitleKey(artist: string, title: string): string {
  return `${artist.trim().toLowerCase()}::${title.trim().toLowerCase()}`;
}
