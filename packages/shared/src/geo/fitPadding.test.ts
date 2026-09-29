import { describe, it, expect } from "vitest";
import { mapFitPadding } from "./fitPadding";

describe("mapFitPadding", () => {
  it("clears the top pill and the bottom sheet, plus a margin", () => {
    expect(
      mapFitPadding({ mapHeight: 800, topOverlay: 110, bottomOverlay: 320, margin: 40 }),
    ).toEqual({
      top: 150,
      right: 40,
      bottom: 360,
      left: 40,
    });
  });

  it("re-fits for a taller sheet", () => {
    const low = mapFitPadding({ mapHeight: 800, topOverlay: 110, bottomOverlay: 300 });
    const high = mapFitPadding({ mapHeight: 800, topOverlay: 110, bottomOverlay: 450 });
    expect(high.bottom).toBeGreaterThan(low.bottom);
  });

  it("always leaves some map visible when the overlays nearly cover it", () => {
    const pad = mapFitPadding({
      mapHeight: 600,
      topOverlay: 150,
      bottomOverlay: 520,
      minVisible: 120,
    });
    expect(pad.top + pad.bottom).toBeLessThanOrEqual(600 - 120);
    expect(pad.top).toBeGreaterThan(0);
  });

  it("returns whole numbers (Android reads edgePadding as integers)", () => {
    const pad = mapFitPadding({ mapHeight: 812.5, topOverlay: 103.3, bottomOverlay: 287.7 });
    for (const value of Object.values(pad)) expect(Number.isInteger(value)).toBe(true);
  });

  it("treats negative overlays as none", () => {
    expect(
      mapFitPadding({ mapHeight: 800, topOverlay: -5, bottomOverlay: -5, margin: 10 }).top,
    ).toBe(10);
  });
});
