import { useMemo } from "react";

/**
 * Algorithmic album-art tile. We don't fetch artwork (free-tier sources
 * don't always carry it); instead we render a deterministic blocky pattern
 * derived from the title+artist hash. Same input → same tile, so the queue
 * has visual continuity without an image pipeline.
 */

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

const PALETTES: ReadonlyArray<readonly string[]> = [
  ["var(--b1)", "var(--b2)", "var(--b3)"],
  ["var(--b2)", "var(--b4)", "var(--b1)"],
  ["var(--b3)", "var(--b5)", "var(--b1)"],
  ["var(--b4)", "var(--b1)", "var(--b6)"],
  ["var(--b5)", "var(--b2)", "var(--b3)"],
];

export function AlbumArt({ seed, size = 96 }: { seed: string; size?: number }) {
  const tiles = useMemo(() => {
    const hash = hashCode(seed);
    const palette = PALETTES[hash % PALETTES.length]!;
    const grid = 4;
    const out: { x: number; y: number; color: string }[] = [];
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid / 2; x++) {
        const value = (hash >> (x * grid + y)) & 7;
        const colorIdx = value % palette.length;
        const color = palette[colorIdx]!;
        out.push({ x, y, color });
        out.push({ x: grid - 1 - x, y, color });
      }
    }
    return { tiles: out, grid };
  }, [seed]);

  const cell = size / tiles.grid;
  return (
    <svg
      width={size}
      height={size}
      className="rounded-2 border border-line-strong"
      style={{ background: "var(--bg-2)" }}
    >
      {tiles.tiles.map((t, i) => (
        <rect
          key={i}
          x={t.x * cell}
          y={t.y * cell}
          width={cell}
          height={cell}
          fill={t.color}
          opacity={0.85}
        />
      ))}
    </svg>
  );
}
