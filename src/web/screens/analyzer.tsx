import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { trpc } from "../trpc";
import type { RouterOutputs } from "../types";
import { LEDMeter } from "../components/primitives/led-meter";
import { TimeSeries } from "../components/primitives/time-series";

type CounterfactualData = RouterOutputs["evals"]["counterfactual"];

/**
 * Analyzer — read-only KPI / counterfactual surface. The plan calls out
 * keep-rate, P@N, bucket purity, genre entropy, and counterfactual replay
 * deltas. We render each as its own panel against a fixed window (last 30
 * days by default).
 */
export function AnalyzerScreen() {
  const [windowDays, setWindowDays] = useState(30);
  const start = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - windowDays);
    return d;
  }, [windowDays]);

  const kpis = trpc.evals.kpis.useQuery({ start });
  const recent = trpc.evals.recentSurface.useQuery({ limit: 60 });

  // Counterfactual replay supports both ranker kinds. Refill versions (v7/v10/v11)
  // carry the LAB-73 novelty-scaled familiarity penalty — selectable here too.
  const [replayKind, setReplayKind] = useState<"refill" | "broad">("broad");
  const versions = trpc.evals.versions.useQuery({ kind: replayKind, limit: 20 });

  const [targetVersion, setTargetVersion] = useState<number | null>(null);
  const counterfactual = trpc.evals.counterfactual.useQuery(
    targetVersion !== null
      ? { targetVersionId: targetVersion, limit: 200 }
      : { targetVersionId: 0 },
    { enabled: targetVersion !== null },
  );

  const keepRateOverTime = useMemo(() => {
    if (!recent.data) return [];
    // Bucketed daily keep-rate. Defer / neutral excluded.
    const byDay = new Map<string, { keep: number; total: number }>();
    for (const r of recent.data) {
      if (r.decision !== "keep" && r.decision !== "dislike") continue;
      const day = r.surfacedAt.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { keep: 0, total: 0 };
      bucket.total += 1;
      if (r.decision === "keep") bucket.keep += 1;
      byDay.set(day, bucket);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({
        t: new Date(day).getTime(),
        v: v.total > 0 ? v.keep / v.total : 0,
      }));
  }, [recent.data]);

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-baseline gap-4 mb-6">
        <span className="font-mono text-ink-3 text-sm tabular-nums">03</span>
        <h1 className="text-ink-1">Analyzer</h1>
        <select
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          className="ml-auto bg-bg-3 border border-line-strong rounded-2 px-2 py-1 text-xs mono text-ink-1"
        >
          <option value={7}>last 7 days</option>
          <option value={30}>last 30 days</option>
          <option value={90}>last 90 days</option>
          <option value={365}>last year</option>
        </select>
      </div>

      {kpis.isLoading || !kpis.data ? (
        <div className="panel p-6 text-ink-3 text-sm">loading kpis…</div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-6 panel p-5">
            <div className="cap text-ink-3 mb-3">keep-rate</div>
            <LEDMeter label="overall" value={kpis.data.keepRate.overall.rate} />
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div>
                <div className="cap text-ink-3 mb-1">by ranker</div>
                <DimRows
                  rows={Object.entries(kpis.data.keepRate.byRanker).map(([k, v]) => ({
                    key: k,
                    rate: v.rate,
                    decided: v.decided,
                  }))}
                />
              </div>
              <div>
                <div className="cap text-ink-3 mb-1">by source</div>
                <DimRows
                  rows={Object.entries(kpis.data.keepRate.bySource).map(([k, v]) => ({
                    key: k,
                    rate: v.rate,
                    decided: v.decided,
                  }))}
                />
              </div>
            </div>
          </div>

          <div className="col-span-3 panel p-5">
            <div className="cap text-ink-3 mb-3">precision</div>
            <div className="space-y-2">
              <KpiRow
                label="P@10"
                value={kpis.data.precisionAt10.precision}
                sub={`${kpis.data.precisionAt10.keptCount}/${kpis.data.precisionAt10.surfacedCount}`}
              />
              <KpiRow
                label="P@25"
                value={kpis.data.precisionAt25.precision}
                sub={`${kpis.data.precisionAt25.keptCount}/${kpis.data.precisionAt25.surfacedCount}`}
              />
            </div>
          </div>

          <div className="col-span-3 panel p-5">
            <div className="cap text-ink-3 mb-3">genre entropy</div>
            <div className="text-ink-1 text-2xl mono tnum">
              {kpis.data.genreEntropy.normalized.toFixed(2)}
            </div>
            <div className="text-ink-3 text-xs mt-1 mono">
              {kpis.data.genreEntropy.distinctGenres} genres /{" "}
              {kpis.data.genreEntropy.totalSurfaced} surfaced
            </div>
          </div>

          <div className="col-span-12 panel p-5">
            <div className="cap text-ink-3 mb-2">keep-rate over time</div>
            <TimeSeries points={keepRateOverTime} width={760} height={120} yMin={0} yMax={1} />
          </div>

          <div className="col-span-6 panel p-5">
            <div className="cap text-ink-3 mb-3">bucket purity</div>
            <div className="space-y-1 max-h-72 overflow-auto">
              {kpis.data.bucketPurity.length === 0 ? (
                <div className="text-ink-3 text-xs italic">no buckets yet</div>
              ) : (
                kpis.data.bucketPurity.map((b) => (
                  <div key={b.bucketId} className="flex items-center gap-3 text-xs">
                    <span className="text-ink-1 truncate flex-1">{b.name}</span>
                    <span className="mono tnum text-ink-2">
                      {b.dislikeCount}/{b.memberCount}
                    </span>
                    <LEDMeter value={b.purity} width={80} segments={8} warnAt={0.99} />
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="col-span-6 panel p-5">
            <div className="cap text-ink-3 mb-2">counterfactual replay</div>
            <div className="text-ink-3 text-xs mb-3">
              Re-rank historical surface events under a target {replayKind} version. Diffs come from
              the FULL candidate pool stored at decision time (Constraint #2).
            </div>
            <div className="flex items-center gap-2 mb-3">
              <select
                value={replayKind}
                onChange={(e) => {
                  // Version ids differ across kinds — reset selection so a stale
                  // broad id can never leak into a refill replay (or vice versa).
                  setReplayKind(e.target.value as "refill" | "broad");
                  setTargetVersion(null);
                }}
                className="bg-bg-3 border border-line-strong rounded-2 px-2 py-1 text-xs mono text-ink-1"
              >
                <option value="broad">broad</option>
                <option value="refill">refill</option>
              </select>
              <select
                value={targetVersion ?? ""}
                onChange={(e) => setTargetVersion(e.target.value ? Number(e.target.value) : null)}
                className="bg-bg-3 border border-line-strong rounded-2 px-2 py-1 text-xs mono text-ink-1"
              >
                <option value="">— select {replayKind} version —</option>
                {(versions.data ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.id} • {new Date(v.trainedAt).toLocaleDateString()}
                    {v.note ? ` • ${v.note.slice(0, 28)}` : ""}
                  </option>
                ))}
              </select>
            </div>
            {counterfactual.data ? (
              <CounterfactualSummary data={counterfactual.data} />
            ) : (
              <div className="text-ink-3 text-xs italic">
                Pick a version to see what it would have surfaced.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DimRows({ rows }: { rows: { key: string; rate: number; decided: number }[] }) {
  if (rows.length === 0) return <div className="text-ink-3 text-xs italic">—</div>;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 text-xs">
          <span className="text-ink-2 w-16 truncate">{r.key}</span>
          <LEDMeter value={r.rate} width={80} segments={8} />
          <span className="mono tnum text-ink-3 w-10 text-right">{r.decided}</span>
        </div>
      ))}
    </div>
  );
}

function KpiRow({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="cap text-ink-3 w-12">{label}</span>
      <span className="text-accent text-2xl mono tnum">{(value * 100).toFixed(0)}%</span>
      <span className="text-ink-3 text-xs mono ml-auto">{sub}</span>
    </div>
  );
}

function CounterfactualSummary({ data }: { data: CounterfactualData }) {
  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <Stat label="scanned" value={data.scannedEventCount} />
        <Stat label="replayed" value={data.replayedEventCount} />
        <Stat label="agreement" value={`${(data.agreementRate * 100).toFixed(0)}%`} />
        <Stat label="agreed-kept" value={data.agreedAndKeptCount} />
        <Stat label="disagreed-disliked" value={data.disagreedAndDislikedCount} />
        <Stat label="rated" value={data.ratedEventCount} />
      </div>
      <div className="cap text-ink-3 mb-1">disagreements</div>
      <div className="border border-line rounded-2 max-h-48 overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-ink-3 cap text-[10px]">
            <tr>
              <th className="text-left p-2">event</th>
              <th className="text-left p-2">original</th>
              <th className="text-left p-2">replayed</th>
              <th className="text-right p-2">orig</th>
              <th className="text-right p-2">repl</th>
            </tr>
          </thead>
          <tbody>
            {data.perEvent
              .filter((e) => !e.agreed)
              .slice(0, 50)
              .map((e) => (
                <tr key={e.surfaceEventId} className="border-t border-line">
                  <td className="p-2 mono text-ink-3">#{e.surfaceEventId}</td>
                  <td className="p-2 mono text-ink-2">t{e.originalTrackId}</td>
                  <td className="p-2 mono text-accent">t{e.replayedTrackId}</td>
                  <td className="p-2 mono tnum text-right text-ink-3">
                    {e.originalScore.toFixed(3)}
                  </td>
                  <td className="p-2 mono tnum text-right text-ink-1">
                    {e.replayedScore.toFixed(3)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={clsx("border border-line rounded-2 p-2")}>
      <div className="cap text-ink-3 mb-1">{label}</div>
      <div className="text-ink-1 mono tnum">{value}</div>
    </div>
  );
}
