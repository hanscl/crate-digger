import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { appConfig, type ModelVersion, modelVersion, type NewModelVersion } from "@/db/schema";
import {
  type BroadConfig,
  isBroadConfig,
  isRefillConfig,
  type RankerKind,
  type RefillConfig,
} from "./types";

/**
 * Constraint #3: ranker versions are first-class. Every ranker/config change
 * bumps `model_version`; ratings tag the version under which they were
 * collected. This file is the single seam through which versions are minted
 * and activated. Both rankers (refill, broad) get independent version chains.
 *
 * Model version = (kind, config). Active version is referenced by
 * `app_config.active_<kind>_version_id`. Bumping creates a new row chained
 * to the prior active version via `parent_id`, then atomically swings the
 * pointer.
 */

const DEFAULT_REFILL_LAMBDA = 0.3;
const DEFAULT_BROAD_PRIOR = 0.5;

export type BumpOptions = {
  /** Free-text annotation surfaced in the Console screen. */
  note?: string;
  /** Window-end timestamps for broad classifier retrains. */
  trainingWindowStart?: Date;
  trainingWindowEnd?: Date;
};

export async function getActiveModelVersion(
  db: Database,
  kind: RankerKind,
): Promise<ModelVersion | null> {
  const [cfg] = await db
    .select({
      activeRefill: appConfig.activeRefillVersionId,
      activeBroad: appConfig.activeBroadVersionId,
    })
    .from(appConfig)
    .limit(1);
  const id = kind === "refill" ? cfg?.activeRefill : cfg?.activeBroad;
  if (!id) return null;
  const [row] = await db.select().from(modelVersion).where(eq(modelVersion.id, id)).limit(1);
  return row ?? null;
}

export async function getModelVersion(db: Database, id: number): Promise<ModelVersion | null> {
  const [row] = await db.select().from(modelVersion).where(eq(modelVersion.id, id)).limit(1);
  return row ?? null;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Internal: mint a new model_version row and swing the active pointer,
 * inside an existing transaction. Caller is responsible for the FOR UPDATE
 * lock on the app_config singleton row (so that callers composing this with
 * a check-and-create stay race-safe). The public `bumpModelVersion` opens
 * its own tx + lock; `ensureActiveModelVersion` reuses a single tx so that
 * its read of "active version id" and the subsequent insert serialize.
 */
async function bumpInTx(
  tx: Tx,
  kind: RankerKind,
  config: RefillConfig | BroadConfig,
  options: BumpOptions,
): Promise<ModelVersion> {
  if (kind === "refill" && !isRefillConfig(config)) {
    throw new Error("bumpModelVersion: refill kind requires RefillConfig");
  }
  if (kind === "broad" && !isBroadConfig(config)) {
    throw new Error("bumpModelVersion: broad kind requires BroadConfig");
  }

  const [cfg] = await tx
    .select({
      activeRefill: appConfig.activeRefillVersionId,
      activeBroad: appConfig.activeBroadVersionId,
    })
    .from(appConfig)
    .where(eq(appConfig.id, 1))
    .limit(1);

  const previousId = kind === "refill" ? cfg?.activeRefill : cfg?.activeBroad;
  const insert: NewModelVersion = {
    kind,
    config,
    parentId: previousId ?? null,
    note: options.note ?? null,
    trainingWindowStart: options.trainingWindowStart ?? null,
    trainingWindowEnd: options.trainingWindowEnd ?? null,
  };
  const [row] = await tx.insert(modelVersion).values(insert).returning();
  if (!row) throw new Error("bumpModelVersion: insert returned no rows");

  const setUpdate =
    kind === "refill"
      ? { activeRefillVersionId: row.id, updatedAt: sql`NOW()` }
      : { activeBroadVersionId: row.id, updatedAt: sql`NOW()` };
  await tx.update(appConfig).set(setUpdate).where(eq(appConfig.id, 1));

  return row;
}

/** Lock the singleton app_config row, creating it on first use. */
async function lockAppConfig(tx: Tx): Promise<void> {
  await tx.insert(appConfig).values({ id: 1 }).onConflictDoNothing({ target: appConfig.id });
  await tx
    .select({ id: appConfig.id })
    .from(appConfig)
    .where(eq(appConfig.id, 1))
    .for("update")
    .limit(1);
}

/**
 * Mint a new model_version row and atomically swing the active pointer.
 * Returns the freshly-inserted row. The previous active version remains in
 * the table — we keep history forever; the only thing that changes is the
 * `app_config.active_*` pointer. `parent_id` chains the lineage so
 * counterfactual replay can walk a track's full history.
 */
export async function bumpModelVersion(
  db: Database,
  kind: RankerKind,
  config: RefillConfig | BroadConfig,
  options: BumpOptions = {},
): Promise<ModelVersion> {
  return db.transaction(async (tx) => {
    await lockAppConfig(tx);
    return bumpInTx(tx, kind, config, options);
  });
}

/**
 * Idempotent bootstrap: ensures both rankers have an active model_version
 * row at first surfacing time. Called by the surfacing pipeline so a fresh
 * install can rank without the user having to manually retrain.
 *
 * Race safety: the entire check-and-create runs inside one transaction with
 * a FOR UPDATE lock on the app_config singleton. Two concurrent first-run
 * surfacing calls for the same `kind` therefore serialize — only the first
 * caller mints a bootstrap row; the second observes the active pointer the
 * first one set and returns that row instead of minting a duplicate.
 */
export async function ensureActiveModelVersion(
  db: Database,
  kind: RankerKind,
): Promise<ModelVersion> {
  return db.transaction(async (tx) => {
    await lockAppConfig(tx);

    const [cfg] = await tx
      .select({
        activeRefill: appConfig.activeRefillVersionId,
        activeBroad: appConfig.activeBroadVersionId,
        refillLambda: appConfig.refillLambda,
      })
      .from(appConfig)
      .where(eq(appConfig.id, 1))
      .limit(1);

    const activeId = kind === "refill" ? cfg?.activeRefill : cfg?.activeBroad;
    if (activeId) {
      const [existing] = await tx
        .select()
        .from(modelVersion)
        .where(eq(modelVersion.id, activeId))
        .limit(1);
      if (existing) return existing;
    }

    const lambda = cfg?.refillLambda ?? DEFAULT_REFILL_LAMBDA;
    if (kind === "refill") {
      return bumpInTx(tx, "refill", { lambda }, { note: "initial bootstrap" });
    }
    return bumpInTx(
      tx,
      "broad",
      { weights: null, bias: 0, trainedSampleCount: 0, prior: DEFAULT_BROAD_PRIOR },
      { note: "initial bootstrap (untrained)" },
    );
  });
}

/**
 * Return all versions of `kind` newest-first. Used by the Analyzer screen
 * to populate a dropdown for counterfactual replay. Optionally filter by
 * lineage (parent chain) when scoping a what-if to a single fork.
 */
export async function listModelVersions(
  db: Database,
  kind: RankerKind,
  options: { limit?: number } = {},
): Promise<ModelVersion[]> {
  const q = db
    .select()
    .from(modelVersion)
    .where(eq(modelVersion.kind, kind))
    .orderBy(desc(modelVersion.trainedAt));
  if (options.limit !== undefined) {
    return q.limit(options.limit);
  }
  return q;
}

/**
 * Walk the parent_id chain from a starting version. Used by evals to surface
 * "what changed between v3 and v6". Returns oldest-first.
 */
export async function modelVersionLineage(
  db: Database,
  versionId: number,
): Promise<ModelVersion[]> {
  const chain: ModelVersion[] = [];
  let cursor: number | null = versionId;
  while (cursor !== null) {
    const row: ModelVersion | null = await getModelVersion(db, cursor);
    if (!row) break;
    chain.unshift(row);
    cursor = row.parentId;
  }
  return chain;
}

/**
 * Convenience: load the active config (typed) for a given ranker. Returns
 * defaults if no version has ever been created — callers can score before
 * `ensureActiveModelVersion` runs.
 */
export async function getActiveConfig<K extends RankerKind>(
  db: Database,
  kind: K,
): Promise<K extends "refill" ? RefillConfig : BroadConfig> {
  const active = await getActiveModelVersion(db, kind);
  if (kind === "refill") {
    if (active && isRefillConfig(active.config)) {
      return active.config as K extends "refill" ? RefillConfig : BroadConfig;
    }
    const [cfg] = await db
      .select({ refillLambda: appConfig.refillLambda })
      .from(appConfig)
      .limit(1);
    const fallback: RefillConfig = { lambda: cfg?.refillLambda ?? DEFAULT_REFILL_LAMBDA };
    return fallback as K extends "refill" ? RefillConfig : BroadConfig;
  }
  if (active && isBroadConfig(active.config)) {
    return active.config as K extends "refill" ? RefillConfig : BroadConfig;
  }
  const fallback: BroadConfig = {
    weights: null,
    bias: 0,
    trainedSampleCount: 0,
    prior: DEFAULT_BROAD_PRIOR,
  };
  return fallback as K extends "refill" ? RefillConfig : BroadConfig;
}

/**
 * Used by tests + retrain workflow to pin the latest training window for a
 * kind without bumping the version (e.g., when a retrain finishes but
 * produced identical weights — record the window, skip the version bump).
 */
export async function latestModelVersionByKind(
  db: Database,
  kind: RankerKind,
): Promise<ModelVersion | null> {
  const [row] = await db
    .select()
    .from(modelVersion)
    .where(and(eq(modelVersion.kind, kind)))
    .orderBy(desc(modelVersion.trainedAt))
    .limit(1);
  return row ?? null;
}
