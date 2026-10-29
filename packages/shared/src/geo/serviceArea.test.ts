/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { haversineDistanceMeters } from "./distance";
import { CAMPUS_GATES } from "../places/campusGates";
import {
  SERVICE_AREA_POLYGON,
  isInServiceArea,
  outsideServiceAreaMessage,
  pointInPolygon,
  zoneForPoint,
} from "./serviceArea";

const ROOT = path.resolve(__dirname, "../../../..");

const square = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
] as const;

describe("pointInPolygon", () => {
  it("is true inside and false outside", () => {
    expect(pointInPolygon({ latitude: 0.5, longitude: 0.5 }, square)).toBe(true);
    expect(pointInPolygon({ latitude: 1.5, longitude: 0.5 }, square)).toBe(false);
    expect(pointInPolygon({ latitude: 0.5, longitude: -0.1 }, square)).toBe(false);
  });
});

describe("the CampusRide service area (Legon campus, west of J.J. Rawlings Avenue)", () => {
  const inside: Record<string, [number, number]> = {
    "Balme Library": [5.65201, -0.18705],
    "Great Hall": [5.65063, -0.19622],
    "Jean Nelson Aka Hall (south end)": [5.63534, -0.18848],
    "UG Medical Centre": [5.63186, -0.18592],
    "Pentagon hostels": [5.65765, -0.18202],
    "James Topp Nelson Yankah Hall (north end)": [5.66626, -0.18209],
    "University of Ghana Sports Stadium": [5.63903, -0.180085],
    "Legon Barrier": [5.64154, -0.19768],
  };
  const outside: Record<string, [number, number]> = {
    Kumasi: [6.6885, -1.6244],
    "Madina Zongo Junction": [5.67633, -0.1779],
    "GIMPA main entrance": [5.63988, -0.20455],
    "Kwame Nkrumah Circle": [5.57, -0.21],
    "East Legon (American House)": [5.6445, -0.1623],
    // Off campus: a future feature, not served now.
    "Accra Mall": [5.62218, -0.17326],
    "Accra Mall roundabout": [5.62204, -0.17473],
    Shiashie: [5.62768, -0.17644],
    "Tetteh Quarshie Interchange": [5.624275, -0.173039],
    // On or east of J.J. Rawlings Avenue (2026-10-29: not served).
    "J.J. Rawlings Avenue at the main gate": [5.65035, -0.17971],
    "Legon Station bus stop (the old Main Gate pin)": [5.65017, -0.17896],
    "Okponglo bus stop (the old Okponglo Gate pin)": [5.63773, -0.17738],
    "Legon Police Station": [5.650671, -0.179585],
    "University of Ghana Hospital": [5.651852, -0.178107],
    "Legon City Mall": [5.653443, -0.178819],
    "Fussag Circle": [5.652586, -0.173834],
  };

  it.each(Object.entries(inside))("includes %s", (_, [latitude, longitude]) => {
    expect(isInServiceArea({ latitude, longitude })).toBe(true);
  });

  it.each(Object.entries(outside))("excludes %s", (_, [latitude, longitude]) => {
    expect(isInServiceArea({ latitude, longitude })).toBe(false);
  });

  it("refuses non-numbers", () => {
    expect(isInServiceArea({ latitude: NaN, longitude: -0.187 })).toBe(false);
  });

  it.each(CAMPUS_GATES.map((g) => [g.name, g] as const))("has %s's inside point", (_, gate) => {
    expect(isInServiceArea(gate.inside)).toBe(true);
    // Drivers never pass a gate: where the area ends at one, the gate itself is outside it.
    if (gate.areaEndsHere) {
      for (const barrier of gate.barriers) expect(isInServiceArea(barrier), `barrier ${barrier.osmNode}`).toBe(false);
    }
  });

  it("has no point of J.J. Rawlings Avenue (or any trunk road or motorway), nor within 25 m of one", () => {
    // assets/map/legon-osm.json: roads around Legon from OpenStreetMap; class 0 = trunk/motorway and their links.
    const osm = JSON.parse(readFileSync(path.join(ROOT, "assets/map/legon-osm.json"), "utf8")) as {
      nodes: number[];
      roads: [number, number, number[]][];
    };
    const trunk = osm.roads.filter(([cls]) => cls === 0).flatMap(([, , nodes]) => nodes);
    expect(trunk.length).toBeGreaterThan(100);
    const edge = SERVICE_AREA_POLYGON.flatMap(([lat, lng], i) => {
      // The edge, every few metres, to measure how close a road comes.
      const [nextLat, nextLng] = SERVICE_AREA_POLYGON[(i + 1) % SERVICE_AREA_POLYGON.length]!;
      return Array.from({ length: 40 }, (_, s) => ({
        latitude: lat + ((nextLat - lat) * s) / 40,
        longitude: lng + ((nextLng - lng) * s) / 40,
      }));
    });
    const problems: string[] = [];
    for (const n of trunk) {
      const point = { latitude: osm.nodes[2 * n]! / 1e5, longitude: osm.nodes[2 * n + 1]! / 1e5 };
      if (point.latitude < 5.62 || point.latitude > 5.67) continue;
      const nearest = Math.min(...edge.map((e) => haversineDistanceMeters(point, e)));
      if (isInServiceArea(point) || nearest < 25) problems.push(`${point.latitude},${point.longitude} (${Math.round(nearest)} m)`);
    }
    expect(problems).toEqual([]);
  });

  it("is the polygon in assets/map/service-area.geojson (regenerate: node scripts/map/service-area.mjs)", () => {
    const geo = JSON.parse(readFileSync(path.join(ROOT, "assets/map/service-area.geojson"), "utf8")) as {
      features: { geometry: { type: string; coordinates: [number, number][][] } }[];
    };
    expect(geo.features).toHaveLength(1);
    const ring = geo.features[0]!.geometry.coordinates[0]!.map(([lng, lat]) => [lat, lng]);
    expect(SERVICE_AREA_POLYGON).toEqual(ring.slice(0, -1));
  });

  it("is a closed ring of [lat, lng] points around Legon", () => {
    expect(SERVICE_AREA_POLYGON.length).toBeGreaterThan(10);
    for (const [lat, lng] of SERVICE_AREA_POLYGON) {
      expect(lat).toBeGreaterThan(5.6);
      expect(lat).toBeLessThan(5.7);
      expect(lng).toBeGreaterThan(-0.21);
      expect(lng).toBeLessThan(-0.16);
    }
  });

  it("explains a refusal in plain words", () => {
    expect(outsideServiceAreaMessage("pickup")).toMatch(/^That pickup is outside campus/);
    expect(outsideServiceAreaMessage("dropoff")).toMatch(/^That drop-off/);
  });
});

describe("zoneForPoint", () => {
  const zones = [
    { id: "a", latitude: 5.6533, longitude: -0.1874 },
    { id: "b", latitude: 5.6490, longitude: -0.1856 },
  ];
  it("gives the nearest zone inside the area, however far its centre is", () => {
    expect(zoneForPoint({ latitude: 5.6534, longitude: -0.1873 }, zones)?.id).toBe("a");
    expect(zoneForPoint({ latitude: 5.631864, longitude: -0.185925 }, zones)?.id).toBe("b"); // UGMC, ~1.9 km
  });
  it("gives none outside the area", () => {
    expect(zoneForPoint({ latitude: 6.6885, longitude: -1.6244 }, zones)).toBeNull();
  });
});
