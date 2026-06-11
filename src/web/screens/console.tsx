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
    queueCeiling: number;
    spawnThreshold: number;
    refillLambda: number;
    audioWeight: number;
    mergeThreshold: number;
    splitDislikeRate: number;
    refillQualityBar: number;
    broadQualityBar: number;
    trendingLimitPerSource: number;
    similarLimitPerSource: number;
    similarSeedBuckets: number;
    similarArtistCap: number;
    familiarArtistKeepThreshold: number;
    surfaceArtistCap: number;
  } | null>(null);

  useEffect(() => {
    if (params.data && draft === null) {
      setDraft({
        novelty: params.data.novelty,
        sourceMix: params.data.sourceMix,
        queueCeiling: params.data.queueCeiling,
        spawnThreshold: params.data.spawnThreshold,
        refillLambda: params.data.refillLambda,
        audioWeight: params.data.audioWeight,
        mergeThreshold: params.data.mergeThreshold,
        splitDislikeRate: params.data.splitDislikeRate,
        refillQualityBar: params.data.refillQualityBar,
        broadQualityBar: params.data.broadQualityBar,
        trendingLimitPerSource: params.data.trendingLimitPerSource,
        similarLimitPerSource: params.data.similarLimitPerSource,
        similarSeedBuckets: params.data.similarSeedBuckets,
        similarArtistCap: params.data.similarArtistCap,
        familiarArtistKeepThreshold: params.data.familiarArtistKeepThreshold,
        surfaceArtistCap: params.data.surfaceArtistCap,
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
            <div className="flex flex-wrap gap-x-8 gap-y-6 items-end mb-6">
              <Fader
                label="novelty"
                info="How strongly to favor fresh artists over ones you already like. Higher = artists you've already kept get pushed down harder, so more new names reach your queue."
                value={draft.novelty}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setDraft({ ...draft, novelty: v })}
                onCommit={(v) => update.mutate({ novelty: v })}
              />
              <Fader
                label="source mix"
                info="The target balance between Spotify and other sources (e.g. Last.fm) in what gets surfaced. 50/50 is balanced; it's a gentle preference, never a hard filter."
                value={draft.sourceMix}
                min={0}
                max={1}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}/${Math.round((1 - v) * 100)}`}
                onChange={(v) => setDraft({ ...draft, sourceMix: v })}
                onCommit={(v) => update.mutate({ sourceMix: v })}
              />
              <Knob
                label="queue ceiling"
                info="The most unrated tracks allowed in your queue at once. Each run tops up only enough to reach this number, so the queue never floods."
                value={draft.queueCeiling}
                min={1}
                max={500}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, queueCeiling: Math.round(v) })}
                onCommit={(v) => update.mutate({ queueCeiling: Math.round(v) })}
              />
              <Knob
                label="artist cap"
                info="The most tracks from any one artist that can be added to your queue in a single run. Keeps one artist from dominating; extras wait for a later run."
                value={draft.surfaceArtistCap}
                min={1}
                max={10}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, surfaceArtistCap: Math.round(v) })}
                onCommit={(v) => update.mutate({ surfaceArtistCap: Math.round(v) })}
              />
            </div>
            <div className="cap text-ink-3 mb-4">ranking</div>
            <div className="flex flex-wrap gap-x-8 gap-y-6 items-end">
              <Knob
                label="refill λ"
                info="How much a track is penalized for sounding like music you've disliked. Higher = disliked-sounding tracks are pushed down more. Changing it starts a new ranker version."
                value={draft.refillLambda}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => setDraft({ ...draft, refillLambda: v })}
                onCommit={(v) => update.mutate({ refillLambda: v })}
              />
              <Knob
                label="audio wt"
                info="How much the sound of a track (tempo, energy, mood) counts versus its genre/metadata when judging similarity. Higher leans on the audio. Changing it starts a new ranker version."
                value={draft.audioWeight}
                min={1}
                max={8}
                step={0.25}
                onChange={(v) => setDraft({ ...draft, audioWeight: v })}
                onCommit={(v) => update.mutate({ audioWeight: v })}
              />
              <Knob
                label="spawn"
                info="How close a kept track must be to an existing taste cluster to join it. Above this it joins the nearest bucket; below, it starts a new one. Higher = more, tighter buckets."
                value={draft.spawnThreshold}
                min={0.3}
                max={0.99}
                step={0.01}
                onChange={(v) => setDraft({ ...draft, spawnThreshold: v })}
                onCommit={(v) => update.mutate({ spawnThreshold: v })}
              />
              <Knob
                label="merge"
                info="How similar two taste buckets must be before the app suggests combining them. Higher = only near-identical buckets are flagged. It only suggests; you confirm merges."
                value={draft.mergeThreshold}
                min={0.6}
                max={0.99}
                step={0.01}
                onChange={(v) => setDraft({ ...draft, mergeThreshold: v })}
                onCommit={(v) => update.mutate({ mergeThreshold: v })}
              />
              <Knob
                label="split rate"
                info="The share of a bucket's tracks you've disliked that triggers a suggestion to split it. Lower = flagged sooner. It only suggests; you confirm splits."
                value={draft.splitDislikeRate}
                min={0.1}
                max={0.95}
                step={0.05}
                onChange={(v) => setDraft({ ...draft, splitDislikeRate: v })}
                onCommit={(v) => update.mutate({ splitDislikeRate: v })}
              />
              <Knob
                label="refill bar"
                info="The minimum similarity-to-your-taste score a 'more like this' track needs to reach your queue. Higher = stricter, fewer but safer picks. Below-bar tracks are kept but not surfaced."
                value={draft.refillQualityBar}
                min={0.3}
                max={0.99}
                step={0.01}
                onChange={(v) => setDraft({ ...draft, refillQualityBar: v })}
                onCommit={(v) => update.mutate({ refillQualityBar: v })}
              />
              <Knob
                label="broad bar"
                info="The minimum predicted-you'll-keep-it score a broad-discovery track needs to reach your queue. Higher = stricter exploration. Below-bar tracks are kept but not surfaced."
                value={draft.broadQualityBar}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setDraft({ ...draft, broadQualityBar: v })}
                onCommit={(v) => update.mutate({ broadQualityBar: v })}
              />
            </div>
            <div className="cap text-ink-3 mb-4 mt-6">ingestion</div>
            <div className="flex flex-wrap gap-x-8 gap-y-6 items-end">
              <Knob
                label="trending pull"
                info="How many trending tracks to pull from each source per run. This is the throttle on fresh inflow — higher pulls more new music each run, lower keeps things slow."
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
                info="How many 'similar artist' tracks to pull per seed each run. The other half of the inflow throttle — higher widens the net around your taste, lower keeps it tight."
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
                info="How many of your top taste clusters are used as seeds for the 'similar artist' pull each run. More seeds reach into more corners of your taste."
                value={draft.similarSeedBuckets}
                min={0}
                max={15}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, similarSeedBuckets: Math.round(v) })}
                onCommit={(v) => update.mutate({ similarSeedBuckets: Math.round(v) })}
              />
              <Knob
                label="similar artist cap"
                info="The most tracks the 'similar artist' pull will take from any one artist in a run, so a single artist can't crowd out the new music being pulled in."
                value={draft.similarArtistCap}
                min={1}
                max={10}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, similarArtistCap: Math.round(v) })}
                onCommit={(v) => update.mutate({ similarArtistCap: Math.round(v) })}
              />
              <Knob
                label="familiar skip"
                info="Artists you've already kept this many times are skipped by the 'similar artist' pull — you know their music, so the run spends its budget on new names instead. Set to 0 to never skip."
                value={draft.familiarArtistKeepThreshold}
                min={0}
                max={10}
                step={1}
                format={(v) => v.toFixed(0)}
                onChange={(v) => setDraft({ ...draft, familiarArtistKeepThreshold: Math.round(v) })}
                onCommit={(v) => update.mutate({ familiarArtistKeepThreshold: Math.round(v) })}
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
                <div className="mt-3 text-xs mono text-keep">
                  pipeline: {runNow.data.status} • surfaced {runNow.data.surfacedCount} • excluded{" "}
                  {runNow.data.excludedDecidedCount} decided / {runNow.data.excludedPendingCount}{" "}
                  pending • artist-diversity: {runNow.data.similarArtistCappedCount} capped /{" "}
                  {runNow.data.similarFamiliarSkippedCount} skipped /{" "}
                  {runNow.data.artistQuotaDeferredCount} quota-deferred
                </div>
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
