import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { clsx } from "clsx";
import { trpc } from "../trpc";
import type { RouterOutputs } from "../types";
import { AlbumArt } from "../components/primitives/album-art";
import { FeatureBar } from "../components/primitives/feature-bar";
import { Radar } from "../components/primitives/radar";
import { Scope } from "../components/primitives/scope";
import { spotifyEmbedUrl, spotifySearchUrl } from "./queue-urls";

type QueueNext = NonNullable<RouterOutputs["queue"]["next"]>;
type QueueRecent = RouterOutputs["queue"]["recent"];

/**
 * Rating Queue — one track at a time. Keep / dislike / defer keyboard
 * shortcuts (J/K/L). Why-surfaced explanation pulled lazily on demand. The
 * server's `queue.next` returns the OLDEST unrated surface event, so the
 * user works through the queue FIFO.
 */
export function QueueScreen() {
  const utils = trpc.useUtils();
  const next = trpc.queue.next.useQuery();
  const depth = trpc.queue.depth.useQuery();
  const recent = trpc.queue.recent.useQuery({ limit: 8 });
  const why = trpc.queue.why.useQuery(next.data ? { eventId: next.data.eventId } : { eventId: 0 }, {
    enabled: !!next.data,
    staleTime: 60_000,
  });

  const rate = trpc.queue.rate.useMutation({
    onSuccess: () => {
      void utils.queue.next.invalidate();
      void utils.queue.depth.invalidate();
      void utils.queue.recent.invalidate();
    },
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!next.data || rate.isPending) return;
      // Don't hijack J/K/L while the user is typing in an input or
      // contenteditable region (e.g. a future search box on this screen).
      const target = (e.target as Element | null) ?? document.activeElement;
      if (target instanceof HTMLElement) {
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === "j" || e.key === "J") {
        rate.mutate({ eventId: next.data.eventId, decision: "keep" });
      } else if (e.key === "k" || e.key === "K") {
        rate.mutate({ eventId: next.data.eventId, decision: "defer" });
      } else if (e.key === "l" || e.key === "L") {
        rate.mutate({ eventId: next.data.eventId, decision: "dislike" });
      } else if (e.key === "n" || e.key === "N") {
        // LAB-76 — neutral: "seen it, indifferent." Settles the track (never
        // re-surfaces) without any taste signal.
        rate.mutate({ eventId: next.data.eventId, decision: "neutral" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next.data, rate]);

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-baseline gap-4 mb-2">
        <span className="font-mono text-ink-3 text-sm tabular-nums">01</span>
        <h1 className="text-ink-1">Rating Queue</h1>
        <span className="ml-auto chip">
          <span className="cap text-ink-3">unrated</span>
          <span className="mono tnum text-ink-1">{depth.data?.unrated ?? "—"}</span>
        </span>
      </div>
      <div className="text-ink-3 text-sm mb-6">
        One track at a time. <kbd className="kbd">J</kbd> keep, <kbd className="kbd">K</kbd> defer,{" "}
        <kbd className="kbd">L</kbd> dislike, <kbd className="kbd">N</kbd> neutral.
      </div>

      {next.isLoading ? (
        <div className="panel p-6 text-ink-3 text-sm">loading…</div>
      ) : !next.data ? (
        <EmptyQueue />
      ) : (
        <CurrentTrack
          data={next.data}
          why={why.data?.reason ?? null}
          submitting={rate.isPending}
          onRate={(decision) => rate.mutate({ eventId: next.data!.eventId, decision })}
        />
      )}

      <RecentRow recent={recent.data ?? []} />
    </div>
  );
}

function EmptyQueue() {
  return (
    <div className="panel p-12 text-center">
      <div className="cap text-ink-3 mb-2">queue empty</div>
      <div className="text-ink-1 mb-6">All caught up.</div>
      <div className="text-ink-3 text-sm">
        Run the daily pipeline from the Console to surface fresh candidates.
      </div>
    </div>
  );
}

function CurrentTrack({
  data,
  why,
  submitting,
  onRate,
}: {
  data: QueueNext;
  why: string | null;
  submitting: boolean;
  onRate: (decision: "keep" | "dislike" | "defer" | "neutral") => void;
}) {
  const { track, ranker } = data;
  const af = track.audioFeatures;
  const subScores = ranker.subScores ?? {};
  const subEntries = Object.entries(subScores);

  return (
    <div className="panel p-6">
      <div className="flex gap-6">
        <AlbumArt seed={`${track.title}::${track.artist}`} size={132} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className={clsx("chip", ranker.kind === "refill" ? "accent" : "warn")}>
              {ranker.kind === "refill" ? "refill" : "broad"}
            </span>
            {ranker.bucketName ? (
              <span
                className="chip mono"
                style={{
                  borderColor: ranker.bucketColor ?? undefined,
                  color: ranker.bucketColor ?? undefined,
                }}
              >
                {ranker.bucketName}
              </span>
            ) : null}
            {data.pending ? (
              <span
                className="chip mono text-ink-3"
                title="joins this bucket if you keep it — not a member yet"
              >
                → {data.pending.bucketName ?? "bucket"}
                {data.pending.score !== null ? ` ${data.pending.score.toFixed(2)}` : ""}
              </span>
            ) : null}
            {track.primaryGenre ? <span className="chip">{track.primaryGenre}</span> : null}
            <span className="ml-auto cap text-ink-3 mono tnum">v{ranker.modelVersionId}</span>
          </div>
          <h2 className="text-ink-1 truncate">{track.title}</h2>
          <div className="text-ink-2 text-sm mb-1">{track.artist}</div>
          <div className="text-ink-3 text-xs mb-4">{track.album ?? ""}</div>

          <div className="flex items-baseline gap-4 mb-4">
            <div>
              <div className="cap text-ink-3">winner score</div>
              <div className="mono tnum text-accent text-2xl">{ranker.score.toFixed(3)}</div>
            </div>
            <div>
              <div className="cap text-ink-3">pool</div>
              <div className="mono tnum text-ink-2">{ranker.poolSize}</div>
            </div>
          </div>

          {subEntries.length > 0 ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 mb-4">
              {subEntries.map(([k, v]) => (
                <div key={k} className="flex justify-between text-xs mono">
                  <span className="text-ink-3">{k}</span>
                  <span className="text-ink-2 tnum">
                    {typeof v === "number" ? v.toFixed(3) : String(v)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="text-ink-2 text-sm italic mb-6">
            {why ?? ranker.surfacedReason ?? "explaining…"}
          </div>

          {track.spotifyId ? (
            <iframe
              title="Spotify preview"
              src={spotifyEmbedUrl(track.spotifyId)}
              width="100%"
              height={80}
              loading="lazy"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              className="mb-6 rounded"
              style={{ border: 0 }}
            />
          ) : (
            <a
              href={spotifySearchUrl(track.artist, track.title)}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline text-sm inline-block mb-6"
            >
              search on Spotify ↗
            </a>
          )}

          <div className="flex gap-3">
            <RatingButton
              disabled={submitting}
              onClick={() => onRate("keep")}
              className="btn primary"
              style={{ background: "var(--keep)", borderColor: "var(--keep)" }}
              tip="Keep it — adds the track to its bucket and teaches the model to surface more like it."
            >
              <kbd className="kbd">J</kbd> keep
            </RatingButton>
            <RatingButton
              disabled={submitting}
              onClick={() => onRate("defer")}
              className="btn"
              tip="Defer — skip for now; it can re-surface later. No taste signal recorded."
            >
              <kbd className="kbd">K</kbd> defer
            </RatingButton>
            <RatingButton
              disabled={submitting}
              onClick={() => onRate("dislike")}
              className="btn"
              style={{ borderColor: "var(--pass)", color: "var(--pass)" }}
              tip="Dislike — soft-penalizes similar tracks going forward; never a hard filter."
            >
              <kbd className="kbd">L</kbd> dislike
            </RatingButton>
            <RatingButton
              disabled={submitting}
              onClick={() => onRate("neutral")}
              className="btn ghost"
              tip="Seen it, indifferent — settles the track so it never re-surfaces, but records no taste signal."
            >
              <kbd className="kbd">N</kbd> neutral
            </RatingButton>
          </div>
        </div>

        <div className="w-48 flex flex-col gap-3">
          <Radar
            values={
              af
                ? {
                    tempo: clamp01(af.tempo / 200),
                    energy: af.energy,
                    valence: af.valence,
                    danceability: af.danceability,
                    acousticness: af.acousticness,
                    instrumentalness: af.instrumentalness,
                  }
                : {}
            }
          />
          {af ? (
            <div className="space-y-1">
              <FeatureBar label="energy" value={af.energy} width={140} />
              <FeatureBar label="valence" value={af.valence} width={140} />
              <FeatureBar label="dance" value={af.danceability} width={140} />
              <FeatureBar label="acoustic" value={af.acousticness} width={140} />
            </div>
          ) : (
            <div className="text-ink-3 text-xs italic">
              no audio features (Spotify retired /audio-features for new apps; genre dims still
              anchor placement)
            </div>
          )}
        </div>
      </div>

      <ScoreRow data={data} />
    </div>
  );
}

/**
 * RatingButton — a rating control that doubles as an accessible tooltip
 * trigger, so every key (J/K/L/N) self-describes on hover AND keyboard focus.
 *
 * We can't reuse the `InfoTip` primitive here because it renders its own
 * `<button>`, and nesting a button inside a rating button is invalid HTML.
 * Instead the rating `<button>` itself is the trigger: it carries
 * `aria-describedby` pointing at a sibling `role="tooltip"` span (revealed on
 * onMouseEnter/Leave + onFocus/onBlur, `aria-hidden` while collapsed). The tip
 * styling/positioning/tokens mirror `InfoTip` (Cyan Tape: bg-bg-3,
 * border-line-strong, the invisible-bridge trick, transition-opacity).
 */
function RatingButton({
  onClick,
  disabled,
  className,
  style,
  tip,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  className: string;
  style?: CSSProperties;
  tip: string;
  children: ReactNode;
}) {
  const id = useId();
  const tipId = `${id}-tip`;
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-describedby={tipId}
        className={className}
        style={style}
      >
        {children}
      </button>
      <span
        id={tipId}
        role="tooltip"
        aria-hidden={!open}
        className={clsx(
          "absolute left-1/2 bottom-full z-20 mb-2 -translate-x-1/2",
          // Invisible bridge across the mb-2 gap so sliding the cursor from the
          // trigger onto the tip never crosses a dead-zone that would fire the
          // wrapper's onMouseLeave and close the tip mid-transit.
          "before:absolute before:inset-x-0 before:top-full before:h-2 before:content-['']",
          "w-52 rounded-2 border border-line-strong bg-bg-3 px-3 py-2",
          "text-left text-xs leading-snug text-ink-2 normal-case tracking-normal font-sans",
          "shadow-[var(--shadow-2)] transition-opacity duration-100",
          // While collapsed the tip is invisible and inert (matches aria-hidden);
          // while open it captures pointer events so the cursor can rest on it.
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {tip}
      </span>
    </span>
  );
}

function ScoreRow({ data }: { data: QueueNext }) {
  // The candidate pool's full score distribution, sorted high-to-low. The
  // surfacing pipeline writes this into surface_event.candidate_pool
  // (Constraint #2). Visualizing it here demystifies WHY this track won.
  // Cap at 50 visible to keep the scope readable.
  const scores: number[] = [];
  // Reconstruct pool from depth's data — actually we have the winner score
  // already; we need the full pool for a real distribution. For now show a
  // synthetic 1-point series (the winner). A future iteration could add
  // pool details to queue.next.
  scores.push(data.ranker.score);
  return (
    <div className="mt-6 flex items-center gap-6 text-xs">
      <div>
        <div className="cap text-ink-3 mb-1">winner</div>
        <Scope values={scores} width={100} height={36} />
      </div>
    </div>
  );
}

function RecentRow({ recent }: { recent: QueueRecent }) {
  if (recent.length === 0) return null;
  return (
    <div className="mt-8">
      <div className="cap text-ink-3 mb-2">recent decisions</div>
      <div className="flex gap-2 flex-wrap">
        {recent.map((r) => (
          <div key={r.ratingId} className="chip">
            <span
              className={clsx(
                "led",
                r.decision === "keep" && "green",
                r.decision === "dislike" && "red",
                r.decision === "defer" && "amber",
              )}
            />
            <span className="text-ink-2 truncate max-w-[12rem]">
              {r.title} — {r.artist}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
