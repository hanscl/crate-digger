import { RequestContext } from "@mastra/core/request-context";
import type { Database } from "@/db/client";
import type { Env } from "@/server/env";

/**
 * Shape of the per-run dependencies workflow steps need. Mastra's
 * RequestContext is the canonical way to thread request-scoped values into
 * step `execute` functions; we use it to inject the live Database handle and
 * validated env without smuggling globals through module state.
 *
 * Steps read `ctx.requestContext.get("db")` / `.get("env")` typed as below.
 */
export type CrateDiggerRequestContext = {
  db: Database;
  env: Env;
};

export type CrateDiggerRequestContextInstance = RequestContext<CrateDiggerRequestContext>;

const DB_KEY = "db" as const;
const ENV_KEY = "env" as const;

/** Build the per-run RequestContext used by every workflow run / agent call. */
export function buildRequestContext(deps: {
  db: Database;
  env: Env;
}): CrateDiggerRequestContextInstance {
  const ctx = new RequestContext<CrateDiggerRequestContext>();
  ctx.set(DB_KEY, deps.db);
  ctx.set(ENV_KEY, deps.env);
  return ctx;
}

/**
 * Read a CrateDigger-typed value off a (possibly opaque) RequestContext. Step
 * `execute` callbacks receive `RequestContext<unknown>` from Mastra, so we
 * recast at the boundary. Throws if the value is missing — that always
 * indicates a wiring bug, not a runtime condition.
 */
export function getDb(rc: RequestContext<unknown>): Database {
  const db = (rc as CrateDiggerRequestContextInstance).get(DB_KEY);
  if (!db)
    throw new Error("RequestContext missing 'db' — workflow not run via buildRequestContext");
  return db;
}

export function getEnv(rc: RequestContext<unknown>): Env {
  const env = (rc as CrateDiggerRequestContextInstance).get(ENV_KEY);
  if (!env)
    throw new Error("RequestContext missing 'env' — workflow not run via buildRequestContext");
  return env;
}
