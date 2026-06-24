import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  ADMIN_PASSPHRASE: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  SPOTIFY_CLIENT_ID: z.string().optional().default(""),
  SPOTIFY_CLIENT_SECRET: z.string().optional().default(""),
  SPOTIFY_REDIRECT_URI: z
    .string()
    .url()
    .optional()
    .default("http://127.0.0.1:3000/api/auth/spotify/callback"),
  LASTFM_API_KEY: z.string().optional().default(""),
  // Contact email folded into the MusicBrainz User-Agent header. Required
  // by MB's API usage policy; the MusicBrainz enricher is skipped when
  // empty so the rest of the pipeline degrades to Last.fm-only genres.
  MUSICBRAINZ_CONTACT_EMAIL: z.string().optional().default(""),
  // Discogs consumer key/secret pair. Both must be set for the Discogs
  // enricher to run; degrades gracefully when either is empty.
  DISCOGS_KEY: z.string().optional().default(""),
  DISCOGS_SECRET: z.string().optional().default(""),
  // Viberate (LAB-88) — paid, OPTIONAL trending-tracks source. The key
  // authorizes data.viberate.com (sent as the `Access-Key` header); absent it
  // the `viberate` adapter is skipped and the system runs fully on
  // Spotify + Last.fm (Constraint #1).
  VIBERATE_API_KEY: z.string().optional().default(""),
  // Viberate trending chart territory (ISO Alpha-2). Defaults to US.
  VIBERATE_TRENDING_COUNTRY: z.string().optional().default("US"),
  // Chartmetric (LAB-117) — social-breakout discovery engine. Usage-based
  // (~$0.01/credit, free trial), no monthly floor, so the cost-effective paid
  // source for a single-user install. This is the long-lived REFRESH token
  // (exchanged for a ~1h bearer); absent it the `chartmetric` adapter is skipped
  // and the system runs on Spotify + Last.fm (Constraint #1).
  CHARTMETRIC_REFRESH_TOKEN: z.string().optional().default(""),
  // Chartmetric chart territory (ISO Alpha-2). Defaults to US.
  CHARTMETRIC_TRENDING_COUNTRY: z.string().optional().default("US"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CRON_DISABLED: z.string().optional().default(""),
});

export type Env = z.infer<typeof schema>;

let _env: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (_env && source === process.env) return _env;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    console.error("Invalid environment variables:", z.treeifyError(parsed.error));
    throw new Error("Environment validation failed");
  }
  if (source === process.env) _env = parsed.data;
  return parsed.data;
}

export function isPaidSourceConfigured(env: Env, source: "viberate" | "chartmetric"): boolean {
  if (source === "viberate") return env.VIBERATE_API_KEY.length > 0;
  if (source === "chartmetric") return env.CHARTMETRIC_REFRESH_TOKEN.length > 0;
  return false;
}
