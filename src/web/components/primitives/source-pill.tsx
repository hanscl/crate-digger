import { clsx } from "clsx";

const SOURCE_LABEL: Record<string, string> = {
  spotify: "Spotify",
  lastfm: "Last.fm",
  viberate: "Viberate",
  tiktok: "TikTok",
  chartmetric: "ChartMetric",
};

export function SourcePill({
  source,
  available = true,
  enabled = true,
  className,
}: {
  source: string;
  available?: boolean;
  enabled?: boolean;
  className?: string;
}) {
  const label = SOURCE_LABEL[source] ?? source;
  const tone = !available
    ? "text-ink-4 border-line"
    : !enabled
      ? "text-ink-3 border-line"
      : "text-accent border-accent/30 bg-accent/10";
  return (
    <span
      className={clsx("chip mono", tone, className)}
      title={!available ? "credentials missing" : !enabled ? "disabled in app config" : "active"}
    >
      <span className={clsx("led", available && enabled ? "on" : "")} />
      {label}
    </span>
  );
}
