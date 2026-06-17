/** Small shared field-normalizers for the Chartmetric engine. */

/** Uppercased, trimmed ISRC; null when absent/blank. */
export function normalizeIsrc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return v.length > 0 ? v : null;
}

/**
 * Year from a Chartmetric date field. Rows carry `release_dates` (an array of
 * ISO strings) or a single `release_date`; take the earliest 4-digit year.
 * Slice rather than `new Date` to avoid TZ drift.
 */
export function parseReleaseYear(raw: unknown): number | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string" || first.length < 4) return null;
  const year = Number.parseInt(first.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Primary-artist-first credit string. Chartmetric rows variously carry
 * `artist_names` (string[] | string), `artists` ([{name}]), or `artist_name`.
 * Tolerate all three (mirrors the retired LAB-19 provider's extractor).
 */
export function extractArtist(e: Record<string, unknown>): string {
  const raw = e.artist_names ?? e.artists ?? e.artist_name;
  if (Array.isArray(raw)) {
    return raw
      .map((n) => (typeof n === "string" ? n : isRecord(n) ? (str(n.name) ?? "") : ""))
      .filter((s) => s.length > 0)
      .join(", ");
  }
  return str(raw) ?? "";
}

/** Title across the documented + conventional key names. */
export function extractTitle(e: Record<string, unknown>): string {
  return str(e.name) ?? str(e.track_title) ?? str(e.title) ?? str(e.track_name) ?? "";
}

/** Trimmed non-empty string, else null. Numbers coerce to their string form. */
export function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim().length > 0 ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Normalized dedup key: lowercased "artist::title". */
export function artistTitleKey(artist: string, title: string): string {
  return `${artist.trim().toLowerCase()}::${title.trim().toLowerCase()}`;
}

/** ISO date (YYYY-MM-DD) `n` days before `now`. Slice avoids TZ drift. */
export function isoDaysAgo(now: Date, n: number): string {
  return new Date(now.getTime() - n * 864e5).toISOString().slice(0, 10);
}
