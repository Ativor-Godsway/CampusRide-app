/** The charts' maths: axis tops and ticks, bar positions, line paths, stacks, heat levels. */
import { describe, expect, it } from "vitest";
import { barSlots, busiest, heatLevel, linePath, niceMax, stack, ticks, yScale } from "./math";

describe("chart maths", () => {
  it("rounds the axis top up to 1, 2, 2.5 or 5 × 10ⁿ", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(10)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(23)).toBe(25);
    expect(niceMax(420)).toBe(500);
    expect(ticks(20, 4)).toEqual([0, 5, 10, 15, 20]);
  });
  it("maps values onto the plot, clamped", () => {
    const y = yScale(10, 100);
    expect(y(0)).toBe(100);
    expect(y(10)).toBe(0);
    expect(y(5)).toBe(50);
    expect(y(20)).toBe(0);
    expect(y(-3)).toBe(100);
  });
  it("lays out groups of bars evenly", () => {
    const slots = barSlots(2, 2, 100, 0.2);
    expect(slots[0]).toEqual({ x: 5, barWidth: 20, centre: 25 });
    expect(slots[1]!.x).toBe(55);
    expect(barSlots(0, 2, 100)).toEqual([]);
  });
  it("draws a line through values, breaking at gaps", () => {
    expect(linePath([0, 10, 5], 100, 100, 10)).toBe("M0 100 L50 0 L100 50");
    expect(linePath([0, null, 5], 100, 100, 10)).toBe("M0 100 M100 50");
    expect(linePath([], 100, 100, 10)).toBe("");
  });
  it("stacks from the bottom up", () => {
    expect(stack([2, 3], 100, 10)).toEqual([
      { y: 80, h: 20 },
      { y: 50, h: 30 },
    ]);
  });
  it("heat levels are relative to the busiest cell; 0 stays 0", () => {
    expect([0, 1, 3, 6, 8].map((v) => heatLevel(v, 8))).toEqual([0, 1, 2, 3, 4]);
    expect(heatLevel(3, 0)).toBe(0);
  });
  it("finds the busiest hour (first on ties), or none", () => {
    expect(busiest([0, 4, 10, 10, 2])).toEqual({ index: 2, value: 10 });
    expect(busiest([0, 0])).toBeNull();
  });
});
