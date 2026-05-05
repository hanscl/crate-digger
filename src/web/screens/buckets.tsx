import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { clsx } from "clsx";
import { trpc } from "../trpc";
import type { RouterOutputs } from "../types";
import { Radar } from "../components/primitives/radar";
import { LEDMeter } from "../components/primitives/led-meter";

type BucketDetailData = RouterOutputs["buckets"]["detail"];

/**
 * Buckets screen. Three panels:
 *
 *   - left: bucket list with health LEDs (green = pure, red = high dislike rate)
 *   - center: selected bucket detail — radar of feature_stats, members
 *   - right: pending recommendations (merge / split)
 *
 * Renames go through `buckets.rename`. Recommendations are accept/dismiss
 * only; there's no "split into N partitions" UX in the MVP.
 */
export function BucketsScreen({ selectedId }: { selectedId?: number }) {
  const [, setLocation] = useLocation();
  const list = trpc.buckets.list.useQuery();
  const recs = trpc.buckets.recommendations.useQuery();
  const utils = trpc.useUtils();

  // Default selection: the first bucket if route didn't pin one.
  const [internalSelected, setInternalSelected] = useState<number | null>(null);
  const id = selectedId ?? internalSelected ?? list.data?.[0]?.id ?? null;

  useEffect(() => {
    if (
      selectedId === undefined &&
      list.data &&
      list.data.length > 0 &&
      internalSelected === null
    ) {
      setInternalSelected(list.data[0]!.id);
    }
  }, [selectedId, list.data, internalSelected]);

  const detail = trpc.buckets.detail.useQuery(id !== null ? { id } : { id: 0 }, {
    enabled: id !== null,
  });

  const rename = trpc.buckets.rename.useMutation({
    onSuccess: () => {
      void utils.buckets.list.invalidate();
      void utils.buckets.detail.invalidate();
    },
  });
  const accept = trpc.buckets.accept.useMutation({
    onSuccess: () => {
      void utils.buckets.list.invalidate();
      void utils.buckets.recommendations.invalidate();
      void utils.buckets.detail.invalidate();
    },
  });
  const dismiss = trpc.buckets.dismiss.useMutation({
    onSuccess: () => void utils.buckets.recommendations.invalidate(),
  });
  const recompute = trpc.buckets.recompute.useMutation({
    onSuccess: () => void utils.buckets.recommendations.invalidate(),
  });

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-baseline gap-4 mb-6">
        <span className="font-mono text-ink-3 text-sm tabular-nums">02</span>
        <h1 className="text-ink-1">Buckets</h1>
        <span className="ml-auto text-ink-3 text-sm">{list.data?.length ?? 0} buckets</span>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-3 panel p-3 flex flex-col gap-1 max-h-[calc(100vh-12rem)] overflow-auto">
          {(list.data ?? []).map((b) => {
            const dislikeRate = b.memberCount > 0 ? b.dislikeCount / b.memberCount : 0;
            const isActive = b.id === id;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  setInternalSelected(b.id);
                  setLocation(`/buckets/${b.id}`);
                }}
                className={clsx(
                  "text-left p-2 rounded-2 border transition-colors",
                  isActive
                    ? "bg-bg-3 border-line-strong"
                    : "border-transparent hover:bg-bg-2 hover:border-line",
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: b.color ?? "var(--ink-4)" }}
                  />
                  <span className="text-ink-1 text-sm truncate flex-1">{b.name}</span>
                  <span
                    className={clsx(
                      "led",
                      dislikeRate > 0.5 ? "red" : dislikeRate > 0.2 ? "amber" : "green",
                    )}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-ink-3 mt-1 mono">
                  <span>{b.primaryGenre ?? "—"}</span>
                  <span>
                    {b.memberCount}m / {b.dislikeCount}d
                  </span>
                </div>
              </button>
            );
          })}
          {list.data && list.data.length === 0 ? (
            <div className="p-6 text-center text-ink-3 text-xs">
              No buckets yet. Rate ~30 tracks or seed a playlist on the Setup screen.
            </div>
          ) : null}
        </div>

        <div className="col-span-6">
          {detail.data ? (
            <BucketDetail
              data={detail.data}
              onRename={(name, color) =>
                rename.mutate({ id: detail.data!.bucket.id, name, color: color ?? null })
              }
            />
          ) : (
            <div className="panel p-6 text-ink-3 text-sm">Select a bucket to inspect.</div>
          )}
        </div>

        <div className="col-span-3 flex flex-col gap-4">
          <div className="panel p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="cap text-ink-3">recommendations</div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => recompute.mutate()}
                disabled={recompute.isPending}
              >
                {recompute.isPending ? "…" : "recompute"}
              </button>
            </div>
            {(recs.data ?? []).length === 0 ? (
              <div className="text-ink-3 text-xs italic">No pending recommendations.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {(recs.data ?? []).map((r) => (
                  <div key={r.id} className="border border-line rounded-2 p-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className={clsx("chip", r.kind === "merge" ? "accent" : "warn")}>
                        {r.kind}
                      </span>
                      <span className="text-ink-3 text-[11px] mono">{r.bucketIds.join(" + ")}</span>
                    </div>
                    <pre className="text-ink-3 text-[10px] mono whitespace-pre-wrap break-all">
                      {JSON.stringify(r.reason, null, 2)}
                    </pre>
                    <div className="flex gap-1 mt-2">
                      <button
                        type="button"
                        className="btn primary sm"
                        onClick={() => accept.mutate({ recommendationId: r.id })}
                        disabled={accept.isPending}
                      >
                        accept
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => dismiss.mutate({ recommendationId: r.id })}
                        disabled={dismiss.isPending}
                      >
                        dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BucketDetail({
  data,
  onRename,
}: {
  data: BucketDetailData;
  onRename: (name: string, color: string | null | undefined) => void;
}) {
  const { bucket: b, members } = data;
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(b.name);
  const [draftColor, setDraftColor] = useState(b.color ?? "#22d3ee");

  // Reset the draft when the user picks a different bucket.
  useEffect(() => {
    setDraftName(b.name);
    setDraftColor(b.color ?? "#22d3ee");
    setEditing(false);
  }, [b.id, b.name, b.color]);

  const dislikeRate = b.memberCount > 0 ? b.dislikeCount / b.memberCount : 0;
  const stats = b.featureStats;
  const radarValues = {
    tempo: stats.mean.tempo > 0 ? clamp01(stats.mean.tempo / 200) : 0.5,
    energy: stats.mean.energy,
    valence: stats.mean.valence,
    danceability: stats.mean.danceability,
    acousticness: stats.mean.acousticness,
    instrumentalness: stats.mean.instrumentalness,
  };

  return (
    <div className="panel p-6">
      <div className="flex gap-6 mb-4">
        <Radar values={radarValues} size={160} color={b.color ?? "var(--accent)"} />
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-col gap-2 mb-3">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="bg-bg-3 border border-line-strong rounded-2 px-2 py-1 text-ink-1 text-sm"
                maxLength={60}
              />
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={draftColor}
                  onChange={(e) => setDraftColor(e.target.value)}
                  className="w-8 h-8 bg-transparent border border-line rounded"
                />
                <span className="mono text-xs text-ink-3">{draftColor}</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => {
                    onRename(draftName, draftColor);
                    setEditing(false);
                  }}
                >
                  save
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 mb-3">
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ background: b.color ?? "var(--ink-4)" }}
              />
              <h2 className="text-ink-1 truncate flex-1">{b.name}</h2>
              <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}>
                rename
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2 mb-3">
            <span className="chip">{b.primaryGenre ?? "—"}</span>
            <span className="chip mono">{b.memberCount} members</span>
            {b.isColdStartSeed ? <span className="chip accent">cold-start</span> : null}
          </div>
          <div className="space-y-2">
            <LEDMeter label="purity" value={1 - dislikeRate} />
            <LEDMeter label="dislikes" value={dislikeRate} warnAt={0.5} />
          </div>
        </div>
      </div>

      <div className="cap text-ink-3 mb-2">members</div>
      <div className="border border-line rounded-2 max-h-[18rem] overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-ink-3 cap text-[10px]">
            <tr>
              <th className="text-left p-2">title</th>
              <th className="text-left p-2">artist</th>
              <th className="text-left p-2">primary</th>
              <th className="text-right p-2">sim</th>
              <th className="text-right p-2">decision</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.trackId} className="border-t border-line">
                <td className="p-2 text-ink-1 truncate max-w-[14rem]">{m.title}</td>
                <td className="p-2 text-ink-2 truncate max-w-[10rem]">{m.artist}</td>
                <td className="p-2 text-ink-3">{m.primaryGenre ?? "—"}</td>
                <td className="p-2 text-right mono tnum text-ink-2">
                  {m.similarityAtJoin?.toFixed(3) ?? "—"}
                </td>
                <td className="p-2 text-right">
                  {m.latestDecision ? (
                    <span
                      className={clsx(
                        "chip mono",
                        m.latestDecision === "keep" && "green",
                        m.latestDecision === "dislike" && "danger",
                        m.latestDecision === "defer" && "warn",
                      )}
                    >
                      {m.latestDecision}
                    </span>
                  ) : (
                    <span className="text-ink-4">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
