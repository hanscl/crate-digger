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
    .default("http://localhost:3000/api/auth/spotify/callback"),
  LASTFM_API_KEY: z.string().optional().default(""),
  VIBERATE_API_KEY: z.string().optional().default(""),
  PORT: z
    .string()
    .optional()
    .default("3000")
    .transform((v) => Number.parseInt(v, 10)),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof schema>;

let _env: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (_env) return _env;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    console.error("Invalid environment variables:", z.treeifyError(parsed.error));
    throw new Error("Environment validation failed");
  }
  _env = parsed.data;
  return _env;
}

export function isPaidSourceConfigured(env: Env, source: "viberate"): boolean {
  if (source === "viberate") return env.VIBERATE_API_KEY.length > 0;
  return false;
}
