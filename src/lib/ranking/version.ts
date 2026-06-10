import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { appConfig, type ModelVersion, modelVersion, type NewModelVersion } from "@/db/schema";
import {
  type BroadConfig,
  DEFAULT_AUDIO_WEIGHT,
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
 * Mint a new version that carries the ACTIVE version's config forward
 * unchanged, inside an existing transaction — for callers whose bump
 * annotates a data repair rather than a config change (e.g. the bucket
 * reconcile sweep, where a membership repair changes the refill keep-anchor
 * set but not lambda). The active pointer AND its config are read under the
 * same app_config FOR UPDATE lock that serializes every bump, so a config
 * change committed concurrently can never be reverted by a stale pre-lock
 * read. Returns null when no active version of `kind` exists — nothing to
 * chain from or carry forward.
 */
export async function bumpModelVersionCarryForwardInTx(
  tx: Tx,
  kind: RankerKind,
  options: BumpOptions = {},
): Promise<ModelVersion | null> {
  await lockAppConfig(tx);
  const [cfg] = await tx
    .select({
      activeRefill: appConfig.activeRefillVersionId,
      activeBroad: appConfig.activeBroadVersionId,
    })
    .from(appConfig)
    .where(eq(appConfig.id, 1))
    .limit(1);
  const activeId = kind === "refill" ? cfg?.activeRefill : cfg?.activeBroad;
  if (!activeId) return null;
  const [active] = await tx
    .select()
    .from(modelVersion)
    .where(eq(modelVersion.id, activeId))
    .limit(1);
  if (!active) return null;
  return bumpInTx(tx, kind, configFromVersion(active, kind), options);
}

/**
 * LAB-36 — idempotent config upgrade for EXISTING installs: when the ACTIVE
 * refill version's config predates the cross-lane fields, mint one refill
 * version carrying lambda forward and filling in whichever fields are
 * missing — `audioWeight` (from the active config when a Console knob bump
 * already froze one, else `app_config.audio_weight`) and
 * `genreGate: 'slot-overlap'` — parent-chained, under the app_config lock
 * (Constraint #3: the gate/metric change must be a version boundary so
 * ratings collected after it attribute to the new chain).
 *
 * The two fields are checked INDEPENDENTLY because they can drift apart: a
 * Console audioWeight bump on a still-legacy `{lambda}` config mints
 * `{lambda, audioWeight}` WITHOUT a gate (the knob never invents one — see
 * the params router), and keying this upgrade on audioWeight alone would
 * leave such an install on the 'exact' fallback forever, with no product
 * path to 'slot-overlap'. An already-frozen audioWeight is carried forward,
 * never overwritten from app_config.
 *
 * Returns null — complete no-op — when the active config already has both
 * fields (re-run), or when no active refill version exists (fresh install:
 * the `ensureActiveModelVersion` bootstrap mints the full config directly).
 * The check-and-mint runs entirely under the lock, so concurrent callers
 * serialize and exactly one mints.
 */
export async function mintRefillAudioWeightUpgradeInTx(
  tx: Tx,
  options: BumpOptions = {},
): Promise<ModelVersion | null> {
  await lockAppConfig(tx);
  const [cfg] = await tx
    .select({
      activeRefill: appConfig.activeRefillVersionId,
      audioWeight: appConfig.audioWeight,
    })
    .from(appConfig)
    .where(eq(appConfig.id, 1))
    .limit(1);
  if (!cfg?.activeRefill) return null;
  const [active] = await tx
    .select()
    .from(modelVersion)
    .where(eq(modelVersion.id, cfg.activeRefill))
    .limit(1);
  if (!active || !isRefillConfig(active.config)) return null;
  if (active.config.audioWeight !== undefined && active.config.genreGate !== undefined) {
    return null;
  }
  return bumpInTx(
    tx,
    "refill",
    {
      lambda: active.config.lambda,
      audioWeight: active.config.audioWeight ?? cfg.audioWeight ?? DEFAULT_AUDIO_WEIGHT,
      genreGate: active.config.genreGate ?? "slot-overlap",
    },
    options,
  );
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
  return db.transaction((tx) => ensureActiveModelVersionInTx(tx, kind));
}

/**
 * Same as `ensureActiveModelVersion`, but reuses an existing transaction.
 * Use this when bootstrapping a version is part of a larger atomic operation
 * (e.g., the cold-start branch of `ingestRating`) — opening a fresh
 * `db.transaction(...)` from within a tx commits independently and would
 * leave the bootstrap row behind even if the outer tx rolls back.
 */
export async function ensureActiveModelVersionInTx(
  tx: Tx,
  kind: RankerKind,
): Promise<ModelVersion> {
  await lockAppConfig(tx);

  const [cfg] = await tx
    .select({
      activeRefill: appConfig.activeRefillVersionId,
      activeBroad: appConfig.activeBroadVersionId,
      refillLambda: appConfig.refillLambda,
      audioWeight: appConfig.audioWeight,
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
    // LAB-36 — fresh installs bootstrap straight onto the cross-lane config
    // (audio-weighted cosine + slot-overlap gate), so the reconcile sweep's
    // upgrade step never fires for them.
    return bumpInTx(
      tx,
      "refill",
      {
        lambda,
        audioWeight: cfg?.audioWeight ?? DEFAULT_AUDIO_WEIGHT,
        genreGate: "slot-overlap",
      },
      { note: "initial bootstrap" },
    );
  }
  return bumpInTx(
    tx,
    "broad",
    { weights: null, bias: 0, trainedSampleCount: 0, prior: DEFAULT_BROAD_PRIOR },
    { note: "initial bootstrap (untrained)" },
  );
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
  const visited = new Set<number>();
  let cursor: number | null = versionId;
  while (cursor !== null) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const row: ModelVersion | null = await getModelVersion(db, cursor);
    if (!row) break;
    chain.unshift(row);
    cursor = row.parentId;
  }
  return chain;
}

/**
 * Pure: narrow a `ModelVersion.config` (jsonb<unknown>) to the typed config
 * for its kind. Use this when you already have a version row in hand —
 * surfacing must extract config from the SAME version it logs to
 * `surface_event.model_version_id`, otherwise a concurrent `bumpModelVersion`
 * between two DB reads would cause events to be logged at version N's id
 * while candidates are scored with version N+1's config — silently breaking
 * counterfactual replay.
 */
export function configFromVersion<K extends RankerKind>(
  version: ModelVersion,
  kind: K,
): K extends "refill" ? RefillConfig : BroadConfig {
  if (kind === "refill") {
    if (!isRefillConfig(version.config)) {
      throw new Error(`configFromVersion: refill version ${version.id} has invalid config`);
    }
    return version.config as K extends "refill" ? RefillConfig : BroadConfig;
  }
  if (!isBroadConfig(version.config)) {
    throw new Error(`configFromVersion: broad version ${version.id} has invalid config`);
  }
  return version.config as K extends "refill" ? RefillConfig : BroadConfig;
}

/**
 * Convenience: load the active config (typed) for a given ranker. Returns
 * defaults if no version has ever been created — callers can score before
 * `ensureActiveModelVersion` runs.
 *
 * Note: this issues a fresh DB read. Surfacing should NOT use this in
 * combination with `ensureActiveModelVersion` — it would race. Use
 * `configFromVersion(version, kind)` against the row you already hold.
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
    // No active version yet — mirror the fresh-install bootstrap config so a
    // pre-bootstrap knob change doesn't mint a legacy-shaped version.
    const [cfg] = await db
      .select({ refillLambda: appConfig.refillLambda, audioWeight: appConfig.audioWeight })
      .from(appConfig)
      .limit(1);
    const fallback: RefillConfig = {
      lambda: cfg?.refillLambda ?? DEFAULT_REFILL_LAMBDA,
      audioWeight: cfg?.audioWeight ?? DEFAULT_AUDIO_WEIGHT,
      genreGate: "slot-overlap",
    };
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
    .where(eq(modelVersion.kind, kind))
    .orderBy(desc(modelVersion.trainedAt))
    .limit(1);
  return row ?? null;
}
