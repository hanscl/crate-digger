import type { Context as HonoContext } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Env } from "./env";

const COOKIE_NAME = "crate_digger_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SESSION_TTL_MS = COOKIE_MAX_AGE * 1000;

const sessions = new Map<string, number>();

function cookieOptions(env: Env, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge,
    secure: env.NODE_ENV === "production",
  } as const;
}

function pruneExpired(now: number): void {
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

export function isAuthenticated(c: HonoContext, env: Env): boolean {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return false;
  const now = Date.now();
  pruneExpired(now);
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= now) return false;
  void env;
  return true;
}

export function login(c: HonoContext, env: Env, passphrase: string): boolean {
  if (!safeEqual(passphrase, env.ADMIN_PASSPHRASE)) return false;
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  setCookie(c, COOKIE_NAME, token, cookieOptions(env, COOKIE_MAX_AGE));
  return true;
}

export function logout(c: HonoContext, env: Env): void {
  const token = getCookie(c, COOKIE_NAME);
  if (token) sessions.delete(token);
  setCookie(c, COOKIE_NAME, "", cookieOptions(env, 0));
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
