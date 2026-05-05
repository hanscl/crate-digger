/**
 * Oscilloscope view of a numeric series — used for the candidate-pool score
 * distribution under the queue's current track and for surface_event score
 * histories. Plots `values` as a polyline with a trace baseline.
 */
export function Scope({
  values,
  width = 220,
  height = 60,
  baseline,
  color = "var(--accent)",
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  baseline?: number;
  color?: string;
}) {
  if (values.length === 0) {
    return <svg width={width} height={height} className="select-none" />;
  }
  const min = Math.min(...values, baseline ?? Number.POSITIVE_INFINITY);
  const max = Math.max(...values, baseline ?? Number.NEGATIVE_INFINITY);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 6) - 3;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const baselineY =
    baseline !== undefined ? height - ((baseline - min) / range) * (height - 6) - 3 : null;

  return (
    <svg width={width} height={height} className="select-none">
      <rect width={width} height={height} fill="var(--bg-3)" />
      {[0.25, 0.5, 0.75].map((g) => (
        <line
          key={g}
          x1={0}
          y1={height * g}
          x2={width}
          y2={height * g}
          stroke="var(--line)"
          strokeDasharray="2 2"
          opacity={0.4}
        />
      ))}
      {baselineY !== null ? (
        <line
          x1={0}
          y1={baselineY}
          x2={width}
          y2={baselineY}
          stroke="var(--ink-2)"
          strokeDasharray="3 3"
          opacity={0.6}
        />
      ) : null}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}
