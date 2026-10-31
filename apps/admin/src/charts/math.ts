/**
 * The maths behind the dashboard's small SVG charts, kept apart so it is
 * tested on its own (math.test.ts): a "nice" top for the axis, its ticks,
 * bar geometry, line paths and the heat grid's levels.
 */

/** The smallest round number ≥ max: 1, 2, 5 × 10ⁿ (and 0 → 1, so empty charts still draw). */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

/** Axis ticks from 0 to `top` (inclusive), `count` intervals, rounded to sensible values. */
export function ticks(top: number, count = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(Math.round((top * i * 100) / count) / 100);
  return out;
}

/** Linear scale from [0, top] onto [height, 0] (SVG y grows downward). */
export function yScale(top: number, height: number): (v: number) => number {
  return (v) => height - (Math.max(0, Math.min(v, top)) / top) * height;
}

export interface BarSlot {
  /** Left edge of the group. */
  x: number;
  /** Width of one bar in the group. */
  barWidth: number;
  /** Centre of the group (for its label). */
  centre: number;
}

/**
 * Where each group of `perGroup` bars sits across `width`: equal slots, a
 * gap of `gapRatio` of the slot between groups, bars side by side.
 */
export function barSlots(groups: number, perGroup: number, width: number, gapRatio = 0.3): BarSlot[] {
  if (groups <= 0) return [];
  const slot = width / groups;
  const inner = slot * (1 - gapRatio);
  const barWidth = inner / perGroup;
  return Array.from({ length: groups }, (_, i) => {
    const x = i * slot + (slot - inner) / 2;
    return { x, barWidth, centre: i * slot + slot / 2 };
  });
}

/** An SVG path through the points ("M x y L x y …"); gaps (null) start a new segment. */
export function linePath(values: readonly (number | null)[], width: number, height: number, top: number): string {
  if (values.length === 0) return "";
  const y = yScale(top, height);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  let path = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    const cmd = pen ? "L" : "M";
    path += `${path ? " " : ""}${cmd}${round(i * step)} ${round(y(v))}`;
    pen = true;
  });
  return path;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Stacked segments of one bar: each value's [y, height] from the bottom up. */
export function stack(values: readonly number[], height: number, top: number): Array<{ y: number; h: number }> {
  let base = 0;
  return values.map((v) => {
    const h = top > 0 ? (Math.max(0, v) / top) * height : 0;
    base += h;
    return { y: height - base, h };
  });
}

/** The heat grid's level for a count: 0 (none) … 4 (the most), relative to the grid's largest. */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  const share = value / max;
  if (share > 0.75) return 4;
  if (share > 0.5) return 3;
  if (share > 0.25) return 2;
  return 1;
}

/** The hour with the most of something, and its count (first one on ties); null when all are 0. */
export function busiest(values: readonly number[]): { index: number; value: number } | null {
  let best: { index: number; value: number } | null = null;
  values.forEach((value, index) => {
    if (value > 0 && (!best || value > best.value)) best = { index, value };
  });
  return best;
}

/** A heat dot's radius (map units) for a count: grows with the square root, relative to the busiest spot. */
export function heatRadius(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return 6 + 18 * Math.sqrt(value / max);
}
