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
