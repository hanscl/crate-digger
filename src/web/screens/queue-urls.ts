/**
 * Pure URL builders for the Rating Queue's inline Spotify player. Extracted
 * from `queue.tsx` so they can be unit-tested in the node test environment
 * without pulling React into the module graph.
 */

export function spotifyEmbedUrl(spotifyId: string): string {
  return `https://open.spotify.com/embed/track/${encodeURIComponent(spotifyId)}`;
}

export function spotifySearchUrl(artist: string, title: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${title}`)}`;
}
