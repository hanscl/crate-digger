import { useEffect, useState } from "react";
import { trpc } from "../trpc";
import { Knob } from "../components/primitives/knob";
import { Fader } from "../components/primitives/fader";

/**
 * Console — the only mutating surface for `app_config`. Knobs commit on
 * pointer-up / arrow-key; the param router bumps the refill model_version
 * when lambda changes (Constraint #3).
 */
export function ConsoleScreen() {
  const utils = trpc.useUtils();
  const params = trpc.params.get.useQuery();
  const update = trpc.params.update.useMutation({
    onSuccess: () => void utils.params.get.invalidate(),
  });
  const runNow = trpc.pipeline.runNow.useMutation({
    onSuccess: () => {
      void utils.queue.next.invalidate();
      void utils.queue.depth.invalidate();
    },
  });
  const retrain = trpc.pipeline.retrainNow.useMutation({
    onSuccess: () => void utils.evals.versions.invalidate(),
  });
  const kpis = trpc.evals.kpis.useQuery();

  const [draft, setDraft] = useState<{
    novelty: number;
    sourceMix: number;
    dailySurfaceCap: number;
    queueCeiling: number;
    spawnThreshold: number;
    refillLambda: number;
    mergeThreshold: number;
    splitDislikeRate: number;
    trendingLimitPerSource: number;
    similarLimitPerSource: number;
    similarSeedBuckets: number;
  } | null>(null);

  useEffect(() => {
    if (params.data && draft === null) {
      setDraft({
        novelty: params.data.novelty,
        sourceMix: params.data.sourceMix,
        dailySurfaceCap: params.data.dailySurfaceCap,
        queueCeiling: params.data.queueCeiling,
        spawnThreshold: params.data.spawnThreshold,
        refillLambda: params.data.refillLambda,
        mergeThreshold: params.data.mergeThreshold,
        splitDislikeRate: params.data.splitDislikeRate,
        trendingLimitPerSource: params.data.trendingLimitPerSource,
        similarLimitPerSource: params.data.similarLimitPerSource,
        similarSeedBuckets: params.data.similarSeedBuckets,
      });
    }
  }, [params.data, draft]);

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-baseline gap-4 mb-6">
        <span className="font-mono text-ink-3 text-sm tabular-nums">04</span>
        <h1 className="text-ink-1">Console</h1>
      </div>

      {!draft || !params.data ? (
        <div className="panel p-6 text-ink-3 text-sm">loading…</div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-7 panel p-6">
            <div className="cap text-ink-3 mb-4">surfacing</div>
            <div className="flex gap-8 items-end mb-6">
              <Fader
                label="novelty"
                value={draft.novelty}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setDraft({ ...draft, novelty: v })}
                onCommit={(v) => update.mutate({ novelty: v })}
              />
              <Fader
                label="source mix"
                value={draft.sourceMix}
                min={0}
                max={1}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}/${Math.round((1 - v) * 100)}`}
                onChange={(v) => setDraft({ ...draft, sourceMix: v })}
                onCommit={(v) => update.mutate({ sourceMix: v })}
              />
              <Knob
                label="daily cap"
                value={draft.dailySurfaceCap}
                min={1}
                max={100}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, dailySurfaceCap: Math.round(v) })}
                onCommit={(v) => update.mutate({ dailySurfaceCap: Math.round(v) })}
              />
              <Knob
                label="queue ceiling"
                value={draft.queueCeiling}
                min={1}
                max={500}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, queueCeiling: Math.round(v) })}
                onCommit={(v) => update.mutate({ queueCeiling: Math.round(v) })}
              />
            </div>
            <div className="cap text-ink-3 mb-4">ranking</div>
            <div className="flex gap-8 items-end">
              <Knob
                label="refill λ"
                value={draft.refillLambda}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => setDraft({ ...draft, refillLambda: v })}
                onCommit={(v) => update.mutate({ refillLambda: v })}
              />
              <Knob
                label="spawn"
                value={draft.spawnThreshold}
                min={0.3}
                max={0.99}
                step={0.01}
                onChange={(v) => setDraft({ ...draft, spawnThreshold: v })}
                onCommit={(v) => update.mutate({ spawnThreshold: v })}
              />
              <Knob
                label="merge"
                value={draft.mergeThreshold}
                min={0.6}
                max={0.99}
                step={0.01}
                onChange={(v) => setDraft({ ...draft, mergeThreshold: v })}
                onCommit={(v) => update.mutate({ mergeThreshold: v })}
              />
              <Knob
                label="split rate"
                value={draft.splitDislikeRate}
                min={0.1}
                max={0.95}
                step={0.05}
                onChange={(v) => setDraft({ ...draft, splitDislikeRate: v })}
                onCommit={(v) => update.mutate({ splitDislikeRate: v })}
              />
            </div>
            <div className="cap text-ink-3 mb-4 mt-6">ingestion</div>
            <div className="flex gap-8 items-end">
              <Knob
                label="trending pull"
                value={draft.trendingLimitPerSource}
                min={0}
                max={25}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, trendingLimitPerSource: Math.round(v) })}
                onCommit={(v) => update.mutate({ trendingLimitPerSource: Math.round(v) })}
              />
              <Knob
                label="similar pull"
                value={draft.similarLimitPerSource}
                min={0}
                max={25}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, similarLimitPerSource: Math.round(v) })}
                onCommit={(v) => update.mutate({ similarLimitPerSource: Math.round(v) })}
              />
              <Knob
                label="seed buckets"
                value={draft.similarSeedBuckets}
                min={0}
                max={15}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, similarSeedBuckets: Math.round(v) })}
                onCommit={(v) => update.mutate({ similarSeedBuckets: Math.round(v) })}
              />
            </div>
            {update.data?.bumped ? (
              <div className="mt-4 chip accent">bumped refill v{update.data.refillVersionId}</div>
            ) : null}
          </div>

          <div className="col-span-5 flex flex-col gap-4">
            <div className="panel p-5">
              <div className="cap text-ink-3 mb-3">manual triggers</div>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="btn primary justify-center"
                  onClick={() => runNow.mutate()}
                  disabled={runNow.isPending}
                >
                  {runNow.isPending ? "running pipeline…" : "Run daily pipeline now"}
                </button>
                <button
                  type="button"
                  className="btn justify-center"
                  onClick={() => retrain.mutate(undefined)}
                  disabled={retrain.isPending}
                >
                  {retrain.isPending ? "retraining…" : "Retrain broad classifier"}
                </button>
              </div>
              {runNow.data ? (
                <div className="mt-3 text-xs mono text-keep">pipeline: {runNow.data.status}</div>
              ) : null}
              {retrain.data ? (
                <div className="mt-3 text-xs mono">
                  {retrain.data.skipped ? (
                    <span className="text-warn">skipped: {retrain.data.skipReason}</span>
                  ) : (
                    <span className="text-keep">
                      v{retrain.data.modelVersionId} • n={retrain.data.sampleCount} • loss=
                      {retrain.data.finalLoss.toFixed(4)}
                    </span>
                  )}
                </div>
              ) : null}
            </div>

            <div className="panel p-5">
              <div className="cap text-ink-3 mb-3">active versions</div>
              <div className="space-y-1 mono text-xs">
                <div className="flex justify-between">
                  <span className="text-ink-3">refill</span>
                  <span className="text-ink-1 tnum">
                    v{params.data.activeRefillVersionId ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">broad</span>
                  <span className="text-ink-1 tnum">
                    v{params.data.activeBroadVersionId ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">audio coverage</span>
                  <span className="text-ink-1 tnum">
                    {kpis.data
                      ? `${Math.round(kpis.data.audioFeatureCoverage.coverage * 100)}% ` +
                        `(${kpis.data.audioFeatureCoverage.withFeatures}/` +
                        `${kpis.data.audioFeatureCoverage.total})`
                      : "—"}
                  </span>
                </div>
              </div>
              <div className="hr" />
              <div className="text-ink-3 text-xs">
                The Mastra Studio dashboard is live at{" "}
                <a
                  href="http://localhost:4111"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  localhost:4111
                </a>{" "}
                while <code className="mono">pnpm dev</code> is running.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
