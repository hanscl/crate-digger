/**
 * Single normalized [0,1] feature display: capped horizontal bar with the
 * value tick marker. Used for audio features (energy, valence, etc.).
 */
export function FeatureBar({
  label,
  value,
  width = 160,
}: {
  label: string;
  value: number;
  width?: number;
}) {
  const ratio = Math.max(0, Math.min(1, value));
  const fillWidth = ratio * width;
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="cap text-ink-3 w-24">{label}</span>
      <div className="bg-bg-3 rounded h-2 relative border border-line" style={{ width }}>
        <div
          className="absolute inset-y-0 left-0 bg-accent rounded"
          style={{ width: fillWidth, opacity: 0.65 }}
        />
        <div className="absolute inset-y-0 w-px bg-accent" style={{ left: fillWidth }} />
      </div>
      <span className="mono tnum text-ink-2 w-10 text-right">{ratio.toFixed(2)}</span>
    </div>
  );
}
