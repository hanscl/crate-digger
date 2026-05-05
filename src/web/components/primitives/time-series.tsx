/**
 * Compact time-series spark with optional value labels at the start and end.
 * Used for the Analyzer's keep-rate-over-time strip.
 */
export function TimeSeries({
  points,
  width = 320,
  height = 80,
  color = "var(--accent)",
  yMin,
  yMax,
  label,
}: {
  points: readonly { t: number; v: number }[];
  width?: number;
  height?: number;
  color?: string;
  yMin?: number;
  yMax?: number;
  label?: string;
}) {
  if (points.length === 0) {
    return (
      <div className="text-ink-3 text-xs italic" style={{ width, height }}>
        no data yet
      </div>
    );
  }
  const ts = points.map((p) => p.t);
  const vs = points.map((p) => p.v);
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const v0 = yMin ?? Math.min(...vs);
  const v1 = yMax ?? Math.max(...vs);
  const tRange = tMax - tMin || 1;
  const vRange = v1 - v0 || 1;
  const padX = 8;
  const padY = 8;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const polyline = points
    .map((p) => {
      const x = padX + ((p.t - tMin) / tRange) * innerW;
      const y = padY + (1 - (p.v - v0) / vRange) * innerH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <div>
      {label ? <div className="cap text-ink-3 mb-1">{label}</div> : null}
      <svg width={width} height={height} className="select-none">
        <rect width={width} height={height} fill="var(--bg-2)" stroke="var(--line)" rx={6} />
        {[0.25, 0.5, 0.75].map((g) => (
          <line
            key={g}
            x1={padX}
            y1={padY + innerH * g}
            x2={width - padX}
            y2={padY + innerH * g}
            stroke="var(--line)"
            strokeDasharray="2 2"
            opacity={0.4}
          />
        ))}
        <polyline points={polyline} fill="none" stroke={color} strokeWidth={1.5} />
        {points.map((p) => {
          const x = padX + ((p.t - tMin) / tRange) * innerW;
          const y = padY + (1 - (p.v - v0) / vRange) * innerH;
          return <circle key={p.t} cx={x} cy={y} r={1.5} fill={color} />;
        })}
      </svg>
    </div>
  );
}
