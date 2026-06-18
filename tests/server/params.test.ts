import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { reconcileBuckets } from "@/lib/bucketing/reconcile";
import { ensureActiveModelVersion, getActiveModelVersion } from "@/lib/ranking/version";
import type { Env } from "@/server/env";
import { paramsRouter } from "@/server/routers/params";
import { createCallerFactory } from "@/server/trpc-base";

/**
 * Params router — Constraint #3 coverage for the version-frozen knobs:
 * `refillLambda` (pre-existing) and `audioWeight` (LAB-36) bump the refill
 * model_version on CHANGE, exactly once per update, with no bump on a
 * same-value write. LAB-92 — `breakoutPenalty` does the same on the BROAD
 * chain, independent of the refill knobs.
 */

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const PROVISION_TIMEOUT = 120_000;

const createCaller = createCallerFactory(paramsRouter);
const caller = () =>
  createCaller({
    db,
    appEnv: {} as Env,
    isAuthenticated: true,
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("cratedigger_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  client = postgres(container.getConnectionUri(), {
    max: 5,
    prepare: false,
    onnotice: () => undefined,
  });
  await client.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, "../../migrations") });
}, PROVISION_TIMEOUT);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(
    sql`UPDATE ${schema.appConfig} SET active_refill_version_id = NULL, active_broad_version_id = NULL`,
  );
  await db.execute(sql`TRUNCATE TABLE ${schema.modelVersion} RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM ${schema.appConfig}`);
});

describe("params.update — audioWeight (LAB-36)", () => {
  it("a changed audioWeight bumps the refill version once, freezing the new weight into its config", async () => {
    const v1 = await ensureActiveModelVersion(db, "refill");
    const result = await caller().update({ audioWeight: 3.5 });
    expect(result.bumped).toBe(true);

    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.audioWeight).toBe(3.5);

    const active = await getActiveModelVersion(db, "refill");
    expect(active?.id).toBe(result.refillVersionId);
    expect(active?.parentId).toBe(v1.id);
    expect(active?.config).toMatchObject({ audioWeight: 3.5 });
    expect(active?.note).toContain("audioWeight update: 2.5 → 3.5");
  });

  it("a same-value audioWeight write does not bump", async () => {
    await ensureActiveModelVersion(db, "refill");
    const result = await caller().update({ audioWeight: 2.5 }); // column default
    expect(result.bumped).toBe(false);
    const versions = await db.select().from(schema.modelVersion);
    expect(versions.filter((v) => v.kind === "refill")).toHaveLength(1);
  });

  it("lambda + audioWeight changed in one update mint ONE version carrying both", async () => {
    const v1 = await ensureActiveModelVersion(db, "refill");
    const result = await caller().update({ refillLambda: 0.6, audioWeight: 4 });
    expect(result.bumped).toBe(true);

    const refillVersions = await db
      .select()
      .from(schema.modelVersion)
      .where(eq(schema.modelVersion.kind, "refill"));
    expect(refillVersions).toHaveLength(2);
    const active = await getActiveModelVersion(db, "refill");
    expect(active?.parentId).toBe(v1.id);
    expect(active?.config).toMatchObject({ lambda: 0.6, audioWeight: 4 });
    expect(active?.note).toContain("lambda update");
    expect(active?.note).toContain("audioWeight update");
  });

  it("rejects out-of-range audioWeight at the zod boundary (<1 and >8)", async () => {
    await ensureActiveModelVersion(db, "refill");
    await expect(caller().update({ audioWeight: 0.5 })).rejects.toThrow();
    await expect(caller().update({ audioWeight: 9 })).rejects.toThrow();
  });

  it("bumping audioWeight on a legacy active config does not invent a genreGate; the reconcile upgrade then installs it", async () => {
    // Conservative: the gate only changes via the reconcile upgrade (or a
    // bootstrap), never as a side effect of turning the weight knob.
    await db.insert(schema.appConfig).values({ id: 1 }).onConflictDoNothing();
    const { bumpModelVersion } = await import("@/lib/ranking/version");
    await bumpModelVersion(db, "refill", { lambda: 0.3 }, { note: "legacy" });

    const result = await caller().update({ audioWeight: 3 });
    expect(result.bumped).toBe(true);
    const active = await getActiveModelVersion(db, "refill");
    expect(active?.config).toEqual({ lambda: 0.3, audioWeight: 3 });
    expect(active?.config).not.toHaveProperty("genreGate");

    // The knob-minted gate-less config must NOT defeat the upgrade: the
    // reconcile sweep keys on the missing gate and finishes the migration,
    // carrying the operator-chosen weight forward.
    const reconciled = await reconcileBuckets(db);
    expect(reconciled.refillConfigUpgraded).toBe(true);
    const upgraded = await getActiveModelVersion(db, "refill");
    expect(upgraded?.parentId).toBe(active?.id);
    expect(upgraded?.config).toEqual({
      lambda: 0.3,
      audioWeight: 3,
      genreGate: "slot-overlap",
      familiarityPenalty: 0.1,
      audioCoverageGate: true,
    });
  });
});

describe("params.update — novelty (LAB-73)", () => {
  it("a changed novelty bumps the refill version once, freezing the scaled familiarity penalty", async () => {
    const v1 = await ensureActiveModelVersion(db, "refill"); // novelty 0.5 → penalty 0.1
    const result = await caller().update({ novelty: 1 });
    expect(result.bumped).toBe(true);

    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.novelty).toBe(1);

    const active = await getActiveModelVersion(db, "refill");
    expect(active?.id).toBe(result.refillVersionId);
    expect(active?.parentId).toBe(v1.id);
    // familiarityPenaltyFromNovelty(1) = 1 × 0.2, frozen into the new version.
    expect(active?.config).toMatchObject({ familiarityPenalty: 0.2 });
    expect(active?.note).toContain("novelty update: 0.5 → 1");
  });

  it("a same-value novelty write does not bump", async () => {
    await ensureActiveModelVersion(db, "refill");
    const result = await caller().update({ novelty: 0.5 }); // column default
    expect(result.bumped).toBe(false);
    const versions = await db.select().from(schema.modelVersion);
    expect(versions.filter((v) => v.kind === "refill")).toHaveLength(1);
  });
});

describe("params.update — breakoutPenalty (LAB-92)", () => {
  it("a changed breakoutPenalty bumps the BROAD version once, freezing the knob into its config", async () => {
    const v1 = await ensureActiveModelVersion(db, "broad"); // bootstrap, breakoutPenalty 0.15
    const result = await caller().update({ breakoutPenalty: 0.3 });
    expect(result.bumped).toBe(true);
    expect(result.broadVersionId).not.toBeNull();
    expect(result.refillVersionId).toBeNull(); // a broad knob never touches the refill chain

    const [cfg] = await db.select().from(schema.appConfig).limit(1);
    expect(cfg?.breakoutPenalty).toBe(0.3);

    const active = await getActiveModelVersion(db, "broad");
    expect(active?.id).toBe(result.broadVersionId);
    expect(active?.parentId).toBe(v1.id);
    expect(active?.config).toMatchObject({ breakoutPenalty: 0.3 });
    expect(active?.note).toContain("breakoutPenalty update: 0.15 → 0.3");
  });

  it("a same-value breakoutPenalty write does not bump", async () => {
    await ensureActiveModelVersion(db, "broad");
    const result = await caller().update({ breakoutPenalty: 0.15 }); // column default
    expect(result.bumped).toBe(false);
    const broadVersions = (await db.select().from(schema.modelVersion)).filter(
      (v) => v.kind === "broad",
    );
    expect(broadVersions).toHaveLength(1);
  });

  it("a breakoutPenalty change bumps ONLY broad, leaving the refill chain untouched", async () => {
    const refillV1 = await ensureActiveModelVersion(db, "refill");
    await ensureActiveModelVersion(db, "broad");
    const result = await caller().update({ breakoutPenalty: 0.4 });
    expect(result.broadVersionId).not.toBeNull();
    expect(result.refillVersionId).toBeNull();
    const refillActive = await getActiveModelVersion(db, "refill");
    expect(refillActive?.id).toBe(refillV1.id);
    const refillVersions = (await db.select().from(schema.modelVersion)).filter(
      (v) => v.kind === "refill",
    );
    expect(refillVersions).toHaveLength(1);
  });
});
