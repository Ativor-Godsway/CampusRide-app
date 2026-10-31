/** The campus map's projection and zoom maths. */
import { describe, expect, it } from "vitest";
import { SERVICE_AREA_POLYGON } from "@rida/shared";
import { FIT, MAX_ZOOM, centreOn, makeProjection, ringPath, roadPaths, zoomAt } from "./geo";

describe("campus map projection", () => {
  const p = makeProjection();
  it("puts the whole service area inside the view, north up", () => {
    for (const [lat, lng] of SERVICE_AREA_POLYGON) {
      const [x, y] = p.project(lat, lng);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(p.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(p.height);
    }
    const [, ySouth] = p.project(5.64, -0.19);
    const [, yNorth] = p.project(5.66, -0.19);
    expect(yNorth).toBeLessThan(ySouth);
  });
  it("unprojects back to the same point", () => {
    const [x, y] = p.project(5.6505, -0.1865);
    const [lat, lng] = p.unproject(x, y);
    expect(lat).toBeCloseTo(5.6505, 6);
    expect(lng).toBeCloseTo(-0.1865, 6);
  });
  it("draws rings closed and roads one path per class", () => {
    expect(ringPath([[5.65, -0.18], [5.66, -0.18], [5.66, -0.19]], p)).toMatch(/^M.* Z$/);
    const roads = roadPaths({ classes: ["primary", "service"], nodes: [5650000, -186000, 5651000, -186000, 5652000, -187000], ways: [[1, 0, 0, 0, [0, 1]], [2, 1, 0, 0, [1, 2]], [3, 0, 0, 0, [2, 0]]] }, p);
    expect(roads.map((r) => r.cls)).toEqual(["primary", "service"]);
    expect(roads[0]!.d.split("M")).toHaveLength(3);
  });
});

describe("zoom", () => {
  it("zooms about a point, keeping it in place, within the limits", () => {
    const v = zoomAt(FIT, 2, 100, 50);
    expect(v.k).toBe(2);
    // The point (100, 50) maps to itself: 100 * 2 + x = 100.
    expect(100 * v.k + v.x).toBeCloseTo(100);
    expect(50 * v.k + v.y).toBeCloseTo(50);
    expect(zoomAt(FIT, 0.5, 0, 0).k).toBe(1);
    expect(zoomAt({ k: MAX_ZOOM, x: 0, y: 0 }, 2, 0, 0).k).toBe(MAX_ZOOM);
  });
  it("centres a point", () => {
    const v = centreOn(300, 200, 4, 1000, 600);
    expect(300 * v.k + v.x).toBe(500);
    expect(200 * v.k + v.y).toBe(300);
  });
});
