import { useCallback, useId, useRef, useState } from "react";
import { clsx } from "clsx";
import { InfoTip } from "./info-tip";

/**
 * Vertical fader. Throws + an LED scale to its right. Same drag-and-keyboard
 * idiom as `Knob`. Use for source-mix, novelty, daily-cap.
 */

export type FaderProps = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  height?: number;
  width?: number;
  label?: string;
  unit?: string;
  /** Optional layman's explanation; renders an (i) tooltip next to the label. */
  info?: string;
  format?: (value: number) => string;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
  disabled?: boolean;
};

const TRACK_W = 6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function snap(value: number, step: number, min: number): number {
  if (step <= 0) return value;
  const n = Math.round((value - min) / step);
  return min + n * step;
}

export function Fader({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  height = 140,
  width = 36,
  label,
  unit,
  info,
  format,
  onChange,
  onCommit,
  disabled = false,
}: FaderProps) {
  const id = useId();
  const range = max - min;
  const ratio = range === 0 ? 0 : clamp((value - min) / range, 0, 1);
  const trackHeight = height - 16;
  const knobY = 8 + (1 - ratio) * trackHeight;

  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const commit = useCallback(
    (next: number) => {
      const snapped = snap(clamp(next, min, max), step, min);
      onChange?.(snapped);
      return snapped;
    },
    [min, max, step, onChange],
  );

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startValue: value };
    setDragging(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY;
    const delta = (dy / trackHeight) * range;
    commit(dragRef.current.startValue + delta);
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY;
    const delta = (dy / trackHeight) * range;
    const final = commit(dragRef.current.startValue + delta);
    dragRef.current = null;
    setDragging(false);
    onCommit?.(final);
  };
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (disabled) return;
    const m = e.shiftKey ? 5 : 1;
    let next = value;
    if (e.key === "ArrowUp") next = value + step * m;
    else if (e.key === "ArrowDown") next = value - step * m;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else return;
    e.preventDefault();
    const final = commit(next);
    onCommit?.(final);
  };

  const display = format ? format(value) : value.toFixed(2);

  // 9 LED ticks on the right, lit up to the current value.
  const leds = [];
  for (let i = 0; i < 9; i++) {
    const ledRatio = i / 8;
    const ledY = 8 + (1 - ledRatio) * trackHeight;
    const lit = ledRatio <= ratio;
    leds.push(
      <rect
        key={i}
        x={width - 6}
        y={ledY - 1}
        width={3}
        height={2}
        fill={lit ? "var(--accent)" : "var(--ink-5)"}
        opacity={lit ? 1 : 0.7}
      />,
    );
  }

  return (
    <div className={clsx("flex flex-col items-center gap-2", disabled && "opacity-50")}>
      <svg
        role="slider"
        aria-labelledby={label !== undefined ? `${id}-label` : undefined}
        aria-label={label === undefined ? "fader" : undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-orientation="vertical"
        tabIndex={disabled ? -1 : 0}
        width={width}
        height={height}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        className={clsx(
          "select-none touch-none",
          dragging ? "cursor-grabbing" : "cursor-grab",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded",
        )}
      >
        {/* track */}
        <rect
          x={width / 2 - TRACK_W / 2}
          y={8}
          width={TRACK_W}
          height={trackHeight}
          rx={3}
          fill="var(--bg-3)"
          stroke="var(--line)"
        />
        {/* fill */}
        <rect
          x={width / 2 - TRACK_W / 2}
          y={knobY}
          width={TRACK_W}
          height={8 + trackHeight - knobY}
          rx={3}
          fill="var(--accent)"
          opacity={0.4}
        />
        {/* LED scale */}
        {leds}
        {/* knob */}
        <rect
          x={width / 2 - 10}
          y={knobY - 6}
          width={20}
          height={12}
          rx={2}
          fill="var(--bg-4)"
          stroke="var(--line-strong)"
        />
        <line
          x1={width / 2 - 7}
          y1={knobY}
          x2={width / 2 + 7}
          y2={knobY}
          stroke="var(--accent)"
          strokeWidth={1}
        />
      </svg>
      {label !== undefined ? (
        <div className="text-center" id={`${id}-label`}>
          <div className="inline-flex items-center gap-1">
            <span className="cap text-ink-3">{label}</span>
            {info ? <InfoTip text={info} label={`${label} — what does this do?`} /> : null}
          </div>
          <div className="mono tnum text-ink-1 text-xs mt-0.5">
            {display}
            {unit ? <span className="text-ink-3 ml-0.5">{unit}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
