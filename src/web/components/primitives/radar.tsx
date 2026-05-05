/**
 * 6-axis radar chart for an audio-features fingerprint. Axis order matches
 * `FEATURE_KEYS` from `src/lib/embedding.ts` so radar labels read top-down
 * the way the feature vector serializes. Pure SVG, no deps.
 */

const AXES = [
  "tempo",
  "energy",
  "valence",
  "danceability",
  "acousticness",
  "instrumentalness",
] as const;

export type RadarPoint = Partial<Record<(typeof AXES)[number], number>>;

export function Radar({
  values,
  size = 140,
  color = "var(--accent)",
  fillOpacity = 0.18,
}: {
  values: RadarPoint;
  size?: number;
  color?: string;
  fillOpacity?: number;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 14;
  const n = AXES.length;

  const pointFor = (axis: (typeof AXES)[number], radius: number) => {
    const idx = AXES.indexOf(axis);
    const angle = (Math.PI * 2 * idx) / n - Math.PI / 2;
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  };

  const polygon = AXES.map((a) => {
    const v = Math.max(0, Math.min(1, values[a] ?? 0));
    const p = pointFor(a, r * v);
    return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }).join(" ");

  const grid = [0.25, 0.5, 0.75, 1].map((rr) => {
    const points = AXES.map((a) => {
      const p = pointFor(a, r * rr);
      return `${p.x},${p.y}`;
    }).join(" ");
    return <polygon key={rr} points={points} fill="none" stroke="var(--line)" strokeWidth={1} />;
  });

  const spokes = AXES.map((a) => {
    const p = pointFor(a, r);
    return <line key={a} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="var(--line)" strokeWidth={1} />;
  });

  const labels = AXES.map((a) => {
    const p = pointFor(a, r + 8);
    return (
      <text
        key={a}
        x={p.x}
        y={p.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={9}
        fill="var(--ink-3)"
        className="mono"
      >
        {a.slice(0, 4)}
      </text>
    );
  });

  return (
    <svg width={size} height={size} className="select-none">
      {grid}
      {spokes}
      <polygon
        points={polygon}
        fill={color}
        fillOpacity={fillOpacity}
        stroke={color}
        strokeWidth={1.5}
      />
      {labels}
    </svg>
  );
}
