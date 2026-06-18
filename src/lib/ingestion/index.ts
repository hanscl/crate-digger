import { AdapterRegistry, type SourceAdapter } from "./adapter";
import { chartmetricAdapter } from "./chartmetric";
import { lastfmAdapter } from "./lastfm";
import { spotifyAdapter } from "./spotify";
import { tiktokAdapter } from "./tiktok";
import { viberateAdapter } from "./viberate";

export { AdapterRegistry, type SourceAdapter } from "./adapter";
export type { PullMode, PullParams, RawCandidate, SourceId } from "./types";
export { spotifyAdapter } from "./spotify";
export { lastfmAdapter } from "./lastfm";
export { viberateAdapter } from "./viberate";
export { tiktokAdapter } from "./tiktok";
export { chartmetricAdapter } from "./chartmetric";

/** Every adapter shipped in the box. The contract test runs against this list. */
export const allAdapters: readonly SourceAdapter[] = [
  spotifyAdapter,
  lastfmAdapter,
  viberateAdapter,
  tiktokAdapter,
  chartmetricAdapter,
];

export function createDefaultRegistry(): AdapterRegistry {
  const r = new AdapterRegistry();
  for (const a of allAdapters) r.register(a);
  return r;
}
