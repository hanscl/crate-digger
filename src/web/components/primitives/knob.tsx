import { useCallback, useId, useRef, useState } from "react";
import { clsx } from "clsx";

/**
 * Cyan Tape rotary knob. Drag vertically to scrub through `[min, max]`.
 * Uncontrolled increment via shift-drag (10x sensitivity inversion). Emits
 * `onChange(value)` continuously and `onCommit(value)` once on pointer-up.
 *
 * Behaviour notes:
 *   - We pin pointer events to the document while dragging so the knob doesn't
 *     "lose" the pointer when it leaves the SVG.
 *   - Keyboard: arrow keys nudge by `step`; shift-arrow by `step * 5`.
 *   - The visual ring renders as an SVG arc from 7 o'clock to 5 o'clock
 *     (270° sweep). Tick marks every 30° trace the analog feel.
 */

export type KnobProps = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  size?: number;
  label?: string;
  unit?: string;
  format?: (value: number) => string;
  disabled?: boolean;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
};

const ARC_START_DEG = 135; // 7 o'clock
const ARC_SWEEP_DEG = 270;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snap(value: number, step: number, min: number): number {
  if (step <= 0) return value;
  const n = Math.round((value - min) / step);
  return min + n * step;
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const start = polar(cx, cy, r, endDeg);
  const end = polar(cx, cy, r, startDeg);
  const largeArc = endDeg - startDeg <= 180 ? "0" : "1";
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

export function Knob({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  size = 64,
  label,
  unit,
  format,
  disabled = false,
  onChange,
  onCommit,
}: KnobProps) {
  const id = useId();
  const range = max - min;
  const ratio = range === 0 ? 0 : clamp((value - min) / range, 0, 1);
  const angle = ARC_START_DEG + ARC_SWEEP_DEG * ratio;
  const r = size / 2 - 4;
  const cx = size / 2;
  const cy = size / 2;
  const indicator = polar(cx, cy, r - 6, angle);

  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const commitValue = useCallback(
    (next: number) => {
      const snapped = snap(clamp(next, min, max), step, min);
      onChange?.(snapped);
      return snapped;
    },
    [min, max, step, onChange],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (disabled) return;
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startValue: value };
      setDragging(true);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [disabled, value],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - e.clientY;
      const sensitivity = e.shiftKey ? 0.001 : 0.005;
      const delta = dy * sensitivity * range;
      commitValue(dragRef.current.startValue + delta);
    },
    [range, commitValue],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - e.clientY;
      const sensitivity = e.shiftKey ? 0.001 : 0.005;
      const delta = dy * sensitivity * range;
      const final = commitValue(dragRef.current.startValue + delta);
      dragRef.current = null;
      setDragging(false);
      onCommit?.(final);
    },
    [range, commitValue, onCommit],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (disabled) return;
      const multiplier = e.shiftKey ? 5 : 1;
      const stepValue = step * multiplier;
      let next = value;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") next = value + stepValue;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = value - stepValue;
      else if (e.key === "Home") next = min;
      else if (e.key === "End") next = max;
      else return;
      e.preventDefault();
      const final = commitValue(next);
      onCommit?.(final);
    },
    [value, step, min, max, disabled, commitValue, onCommit],
  );

  const display = format ? format(value) : value.toFixed(2);
  const ticks = [];
  for (let i = 0; i <= 9; i++) {
    const a = ARC_START_DEG + (ARC_SWEEP_DEG * i) / 9;
    const inner = polar(cx, cy, r - 1, a);
    const outer = polar(cx, cy, r + 2, a);
    ticks.push(
      <line
        key={i}
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.25}
      />,
    );
  }

  return (
    <div className={clsx("flex flex-col items-center gap-2", disabled && "opacity-50")}>
      <svg
        role="slider"
        aria-labelledby={label !== undefined ? `${id}-label` : undefined}
        aria-label={label === undefined ? "knob" : undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={disabled ? -1 : 0}
        width={size}
        height={size}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        className={clsx(
          "select-none touch-none",
          dragging ? "cursor-grabbing" : "cursor-grab",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded-full",
        )}
      >
        <circle cx={cx} cy={cy} r={r} fill="var(--bg-3)" stroke="var(--line-strong)" />
        <g className="text-ink-3">{ticks}</g>
        <path
          d={describeArc(cx, cy, r - 6, ARC_START_DEG, angle)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <line
          x1={cx}
          y1={cy}
          x2={indicator.x}
          y2={indicator.y}
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={2} fill="var(--ink-3)" />
      </svg>
      {label !== undefined ? (
        <div className="text-center" id={`${id}-label`}>
          <div className="cap text-ink-3">{label}</div>
          <div className="mono tnum text-ink-1 text-xs mt-0.5">
            {display}
            {unit ? <span className="text-ink-3 ml-0.5">{unit}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
