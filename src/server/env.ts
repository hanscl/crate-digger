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
  VIBERATE_API_KEY: z.string().optional().default(""),
  // Chartmetric (LAB-19) — DEFAULT TikTok-velocity provider. Usage-based
  // (~$0.01/credit, free trial), so the cost-effective choice for a single-user
  // install. This is the long-lived REFRESH token (exchanged for a ~1h bearer);
  // absent it, the adapter falls back to Soundcharts, then to unavailable
  // (system runs on Spotify + Last.fm — Constraint #1).
  CHARTMETRIC_REFRESH_TOKEN: z.string().optional().default(""),
  // TikTok chart territory (ISO Alpha-2). Defaults to US.
  CHARTMETRIC_TIKTOK_COUNTRY: z.string().optional().default("US"),
  // Soundcharts (LAB-19) — ALTERNATIVE TikTok-velocity provider ($250/mo floor;
  // live-verified). BOTH the app id and api key are required; the public sandbox
  // creds are `soundcharts` / `soundcharts` (fixed demo data).
  SOUNDCHARTS_APP_ID: z.string().optional().default(""),
  SOUNDCHARTS_API_KEY: z.string().optional().default(""),
  // Which TikTok chart to pull (Soundcharts slug). Defaults to the US
  // "Breakout" velocity chart; e.g. tiktok-breakout-gb, tiktok-breakout-de.
  SOUNDCHARTS_TIKTOK_CHART_SLUG: z.string().optional().default("tiktok-breakout-us"),
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

export function isPaidSourceConfigured(env: Env, source: "viberate"): boolean {
  if (source === "viberate") return env.VIBERATE_API_KEY.length > 0;
  return false;
}
