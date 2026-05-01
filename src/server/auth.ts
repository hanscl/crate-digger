import type { Context as HonoContext } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";
import type { Env } from "./env";

const COOKIE_NAME = "crate_digger_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function isAuthenticated(c: HonoContext, env: Env): boolean {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return false;
  return safeEqual(token, env.ADMIN_PASSPHRASE);
}

export function login(c: HonoContext, env: Env, passphrase: string): boolean {
  if (!safeEqual(passphrase, env.ADMIN_PASSPHRASE)) return false;
  setCookie(c, COOKIE_NAME, env.ADMIN_PASSPHRASE, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    secure: env.NODE_ENV === "production",
  });
  return true;
}

export function logout(c: HonoContext): void {
  setCookie(c, COOKIE_NAME, "", { path: "/", maxAge: 0 });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
