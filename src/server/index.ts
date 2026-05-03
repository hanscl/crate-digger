import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { z } from "zod";
import { getDb } from "@/db/client";
import { isAuthenticated, login, logout } from "./auth";
import { loadEnv } from "./env";
import { appRouter } from "./trpc";

const env = loadEnv();
const db = getDb(env.DATABASE_URL);

const app = new Hono();

app.use("*", logger());

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ passphrase: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ ok: false }, 400);
  const ok = login(c, env, parsed.data.passphrase);
  return c.json({ ok }, ok ? 200 : 401);
});

app.post("/api/auth/logout", (c) => {
  logout(c, env);
  return c.json({ ok: true });
});

app.use("/trpc/*", async (c, next) => {
  const authed = isAuthenticated(c, env);
  return trpcServer({
    router: appRouter,
    createContext: () => ({ db, env, isAuthenticated: authed }),
    endpoint: "/trpc",
  })(c, next);
});

// Serve the built SPA. Registered as GET-only so unmatched POST/PUT/DELETE
// requests under /api or /trpc still produce 404s rather than HTML responses.
// First handler resolves real files (index.html for /, assets/*, etc.); the
// second is the SPA fallback for client-side routes like /queue, /buckets.
app.get("/*", serveStatic({ root: "./dist/web" }));
app.get("/*", serveStatic({ path: "./dist/web/index.html" }));

const port = env.PORT;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`crate-digger api listening on :${info.port}`);
});
