import { describe, expect, it } from "vitest";
import { computeZoneNeighbours, zonePairKey, NEIGHBOUR_MAX_CENTRE_METERS } from "./zoneNeighbours";

/** The 14 zones in service in production (apps/server/src/scripts/realignZones.ts REAL_ZONE_CENTRES). */
const CAMPUS = [
  ["Main Gate", 5.6503, -0.18139],
  ["Legon Hall", 5.649374, -0.187998],
  ["Commonwealth Hall", 5.650804, -0.192672],
  ["Volta Hall", 5.651496, -0.189693],
  ["Akuafo Hall", 5.649357, -0.186087],
  ["Mensah Sarbah Hall", 5.645691, -0.186598],
  ["ISH", 5.639769, -0.185137],
  ["School of Business", 5.652809, -0.188627],
  ["Great Hall", 5.650634, -0.196217],
  ["Balme Library", 5.652012, -0.187048],
  ["Pentagon Hostel", 5.657652, -0.182018],
  ["UGMC", 5.631864, -0.185925],
  ["Sports Stadium", 5.63903, -0.180085],
  ["TF Hall", 5.666259, -0.182087],
] as const;
const zones = CAMPUS.map(([id, latitude, longitude]) => ({ id, latitude, longitude }));
const pairs = computeZoneNeighbours(zones, undefined, { gridMeters: 20 });
const has = (a: string, b: string) => pairs.some((p) => zonePairKey(p.a, p.b) === zonePairKey(a, b));

describe("computeZoneNeighbours on the real campus zones", () => {
  it("is a real neighbour structure, not every zone next to every other", () => {
    expect(pairs.length).toBeGreaterThan(30);
    expect(pairs.length).toBeLessThan(50);
    expect(pairs.length).toBeLessThan((zones.length * (zones.length - 1)) / 2);
  });

  it("pairs zones side by side, and every pair with centres within 800 m", () => {
    expect(has("School of Business", "Volta Hall")).toBe(true);
    expect(has("Akuafo Hall", "Legon Hall")).toBe(true);
    expect(has("ISH", "UGMC")).toBe(true);
    expect(has("TF Hall", "Pentagon Hostel")).toBe(true);
    for (const p of pairs) expect(p.centreMeters <= NEIGHBOUR_MAX_CENTRE_METERS || p.borderMeters >= 150).toBe(true);
  });

  it("never pairs zones across campus, nor ones that only meet at a corner of the campus edge", () => {
    expect(has("TF Hall", "UGMC")).toBe(false);
    expect(has("Great Hall", "UGMC")).toBe(false);
    expect(has("Pentagon Hostel", "Sports Stadium")).toBe(false);
    expect(has("Main Gate", "Great Hall")).toBe(false);
  });

  it("leaves no zone without a neighbour", () => {
    for (const z of zones) expect(pairs.some((p) => p.a === z.id || p.b === z.id)).toBe(true);
  });

  it("gives each pair once, sorted ids, nearest first", () => {
    expect(new Set(pairs.map((p) => zonePairKey(p.a, p.b))).size).toBe(pairs.length);
    for (const p of pairs) expect(p.a < p.b).toBe(true);
    for (let i = 1; i < pairs.length; i++) expect(pairs[i]!.centreMeters).toBeGreaterThanOrEqual(pairs[i - 1]!.centreMeters);
  });
});

describe("computeZoneNeighbours on a simple square", () => {
  // A 2 km × 2 km square with three zones in a row, 900 m apart: the outer two
  // are separated by the middle one, so they never touch.
  const square = [[0, 0], [0, 0.018], [0.018, 0.018], [0.018, 0]] as const;
  const row = [
    { id: "w", latitude: 0.009, longitude: 0.001 },
    { id: "m", latitude: 0.009, longitude: 0.0091 },
    { id: "e", latitude: 0.009, longitude: 0.0172 },
  ];
  it("cells that share a border are neighbours, cells that don't aren't", () => {
    const result = computeZoneNeighbours(row, square, { gridMeters: 25 });
    expect(result.map((p) => zonePairKey(p.a, p.b)).sort()).toEqual([zonePairKey("m", "w"), zonePairKey("e", "m")].sort());
    expect(result.every((p) => p.borderMeters >= 1900)).toBe(true);
  });

  it("needs two zones and an area", () => {
    expect(computeZoneNeighbours([row[0]!], square)).toEqual([]);
    expect(computeZoneNeighbours(row, [])).toEqual([]);
  });
});
