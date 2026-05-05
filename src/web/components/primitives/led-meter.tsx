import { clsx } from "clsx";

/**
 * Horizontal LED bar. Used for keep-rate, P@N, and any [0,1] indicator.
 * `segments` LEDs lit proportionally; the last LED in the lit run flashes
 * the warning color above `warnAt`.
 */
export function LEDMeter({
  value,
  max = 1,
  segments = 14,
  width = 140,
  height = 14,
  warnAt = 0.85,
  label,
}: {
  value: number;
  max?: number;
  segments?: number;
  width?: number;
  height?: number;
  warnAt?: number;
  label?: string;
}) {
  // Sanitize props so non-finite or zero values can't yield NaN labels or
  // negative segment widths. Defaults match the destructuring above.
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  // Clamp to ≥1 so fractional inputs like 0.5 don't floor to 0 and produce a
  // divide-by-zero in the segment-width calculation below.
  const safeSegments =
    Number.isFinite(segments) && segments > 0 ? Math.max(1, Math.floor(segments)) : 14;
  const safeValue = Number.isFinite(value) ? value : 0;
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 140;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 14;
  const ratio = Math.max(0, Math.min(1, safeValue / safeMax));
  const lit = Math.round(safeSegments * ratio);
  const seg = Math.max(1, (safeWidth - safeSegments + 1) / safeSegments);
  return (
    <div className="flex items-center gap-2">
      {label ? <span className="cap text-ink-3 w-20">{label}</span> : null}
      <svg width={safeWidth} height={safeHeight} className="select-none">
        {Array.from({ length: safeSegments }, (_, i) => {
          const isLit = i < lit;
          const isWarn = isLit && i / safeSegments >= warnAt;
          const color = isLit ? (isWarn ? "var(--warn)" : "var(--accent)") : "var(--ink-5)";
          return (
            <rect
              key={i}
              x={i * (seg + 1)}
              y={2}
              width={seg}
              height={Math.max(1, safeHeight - 4)}
              rx={1}
              fill={color}
              opacity={isLit ? 1 : 0.6}
            />
          );
        })}
      </svg>
      <span className={clsx("mono tnum text-xs text-ink-2 tabular-nums w-10 text-right")}>
        {(ratio * 100).toFixed(0)}%
      </span>
    </div>
  );
}
