import type { Env } from "@/server/env";
import type { PullParams, RawCandidate, SourceId } from "./types";

/**
 * Common interface every source adapter implements. New sources land as
 * one file in this directory + a registration in the default registry —
 * nothing else in the pipeline changes.
 *
 * Constraint #1: paid sources are optional; the system runs fully on the
 * free adapters when paid credentials are absent. Adapters MUST signal
 * absence via `isAvailable(env) === false` rather than throwing.
 */
export interface SourceAdapter {
  readonly id: SourceId;
  readonly isPaid: boolean;
  /** True iff the adapter has the credentials it needs to issue real calls. */
  isAvailable(env: Env): boolean;
  /**
   * Pull candidates. MUST resolve, never reject, on rate-limit / network /
   * upstream errors — return `[]` and log. Throwing here would crash the
   * ingestion pipeline; failure of one source must not take down the rest.
   */
  pullCandidates(params: PullParams, env: Env): Promise<RawCandidate[]>;
}

export class AdapterRegistry {
  private readonly byId = new Map<SourceId, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    this.byId.set(adapter.id, adapter);
    return this;
  }

  get(id: SourceId): SourceAdapter | undefined {
    return this.byId.get(id);
  }

  list(): SourceAdapter[] {
    return [...this.byId.values()];
  }

  /** Adapters that currently have the credentials they need. */
  available(env: Env): SourceAdapter[] {
    return this.list().filter((a) => a.isAvailable(env));
  }
}
