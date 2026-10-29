/// <reference types="node" />
/**
 * The campus route engine on the real campus road graph
 * (assets/map/campus-roads.json): routes stay on campus, off trunk roads,
 * the right way down one-ways, and through no closed gate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { haversineDistanceMeters } from "../geo/distance";
import { isInServiceArea } from "../geo/serviceArea";
import { CAMPUS_GATES } from "../places/campusGates";
import {
  CampusRouter,
  MAX_SNAP_METERS,
  isCampusRouteError,
  type CampusRoadData,
  type CampusRoute,
} from "./campusRouter";

const ROOT = path.resolve(__dirname, "../../../..");
const data = JSON.parse(readFileSync(path.join(ROOT, "assets/map/campus-roads.json"), "utf8")) as CampusRoadData;
const router = new CampusRouter(data);

const PLACES = {
  mainGateInside: { latitude: 5.6503, longitude: -0.18139 },
  stadiumGate: { latitude: 5.640669, longitude: -0.18105 },
  tfGate: { latitude: 5.66485, longitude: -0.18256 },
  tfHall: { latitude: 5.666259, longitude: -0.182087 },
  balme: { latitude: 5.652012, longitude: -0.187048 },
  commonwealth: { latitude: 5.650804, longitude: -0.192672 },
  volta: { latitude: 5.651496, longitude: -0.189693 },
  ugbs: { latitude: 5.652809, longitude: -0.188627 },
  pentagon: { latitude: 5.657652, longitude: -0.182018 },
  akuafo: { latitude: 5.649357, longitude: -0.186087 },
  ugmc: { latitude: 5.631864, longitude: -0.185925 },
  greatHall: { latitude: 5.650634, longitude: -0.196217 },
};

function routeOrThrow(...points: { latitude: number; longitude: number }[]): CampusRoute {
  const r = router.route(points);
  if (isCampusRouteError(r)) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

/** Trunk roads and motorways near campus (J.J. Rawlings Avenue and its ramps), from assets/map/legon-osm.json. */
const trunkPoints = (() => {
  const osm = JSON.parse(readFileSync(path.join(ROOT, "assets/map/legon-osm.json"), "utf8")) as {
    nodes: number[];
    roads: [number, number, number[]][];
  };
  return osm.roads
    .filter(([cls]) => cls === 0)
    .flatMap(([, , nodes]) => nodes.map((n) => ({ latitude: osm.nodes[2 * n]! / 1e5, longitude: osm.nodes[2 * n + 1]! / 1e5 })))
    .filter((p) => p.latitude > 5.62 && p.latitude < 5.672);
})();

/** Deterministic pseudo-random graph nodes, spread over campus. */
function sampleNodes(count: number): number[] {
  let x = 12345;
  return Array.from({ length: count }, () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x % router.nodeCount;
  });
}

describe("the campus road graph", () => {
  it("is all inside the service area", () => {
    const outside = [];
    for (let i = 0; i < router.nodeCount; i++) if (!isInServiceArea(router.nodePoint(i))) outside.push(i);
    expect(outside).toEqual([]);
  });

  it("has no trunk road: no point within 25 m of J.J. Rawlings Avenue or any trunk road", () => {
    expect(data.classes.some((c) => /trunk|motorway/.test(c))).toBe(false);
    expect(trunkPoints.length).toBeGreaterThan(100);
    const near = [];
    for (let i = 0; i < router.nodeCount; i++) {
      const p = router.nodePoint(i);
      if (trunkPoints.some((t) => haversineDistanceMeters(p, t) < 25)) near.push(data.osmNodes[i]);
    }
    expect(near).toEqual([]);
  });

  it("has no closed gate: the Main and Stadium gates aren't in it, the TF gate is (TF Hall stays reachable)", () => {
    const nodes = new Set(data.osmNodes);
    for (const gate of CAMPUS_GATES) {
      for (const barrier of gate.barriers) {
        const expected = gate.source === "manual:tf-gate";
        expect(nodes.has(barrier.osmNode), `${gate.name} barrier ${barrier.osmNode}`).toBe(expected);
      }
    }
    // Every closed barrier the builder recorded is out of the graph.
    for (const [id, open] of data.barriers ?? []) if (!open) expect(nodes.has(id), `barrier ${id}`).toBe(false);
  });
});

describe("CampusRouter.route", () => {
  it("routes the example trips, every point on campus", () => {
    const trips = [
      [PLACES.mainGateInside, PLACES.balme],
      [PLACES.stadiumGate, PLACES.commonwealth],
      [PLACES.tfGate, PLACES.tfHall],
      [PLACES.volta, PLACES.ugbs],
      [PLACES.pentagon, PLACES.akuafo],
    ];
    for (const trip of trips) {
      const r = routeOrThrow(...trip);
      expect(r.path.every((p) => isInServiceArea(p))).toBe(true);
      expect(r.distanceMeters).toBeGreaterThan(0);
      expect(r.durationSeconds).toBeGreaterThan(0);
      expect(r.legs).toHaveLength(1);
    }
  });

  it("drives through the TF gate to TF Hall (the one gate cars may pass)", () => {
    const r = routeOrThrow(PLACES.balme, PLACES.tfHall);
    const tfBarriers = CAMPUS_GATES.find((g) => g.source === "manual:tf-gate")!.barriers.map((b) => b.osmNode);
    expect(r.nodePath.some((i) => tfBarriers.includes(data.osmNodes[i]!))).toBe(true);
  });

  it("never drives a one-way road the wrong way, nor leaves the campus, on 200 random trips", () => {
    const nodes = sampleNodes(400);
    let routed = 0;
    for (let k = 0; k < nodes.length; k += 2) {
      const r = router.route([router.nodePoint(nodes[k]!), router.nodePoint(nodes[k + 1]!)]);
      if (isCampusRouteError(r)) continue;
      routed += 1;
      for (let i = 1; i < r.nodePath.length; i++) {
        expect(router.allows(r.nodePath[i - 1]!, r.nodePath[i]!), `trip ${k / 2}, step ${i}`).toBe(true);
      }
      expect(r.path.every((p) => isInServiceArea(p))).toBe(true);
    }
    expect(routed).toBeGreaterThan(150);
  });

  it("goes around a one-way road rather than up it the wrong way", () => {
    // Pick a one-way way of at least 3 points; drive from its end back to its start.
    const oneway = data.ways.find(([, , dir, , idx]) => dir === 1 && idx.length >= 3)!;
    const idx = oneway[4];
    const start = router.nodePoint(idx[idx.length - 1]!);
    const end = router.nodePoint(idx[0]!);
    const r = router.route([start, end]);
    if (isCampusRouteError(r)) return; // A dead-end one-way: no way back at all, which is also right.
    const straight = haversineDistanceMeters(start, end);
    for (let i = 1; i < r.nodePath.length; i++) expect(router.allows(r.nodePath[i - 1]!, r.nodePath[i]!)).toBe(true);
    expect(r.distanceMeters).toBeGreaterThan(straight);
  });

  it("goes through several stops, one leg each", () => {
    const r = routeOrThrow(PLACES.pentagon, PLACES.balme, PLACES.greatHall);
    expect(r.legs).toHaveLength(2);
    expect(r.distanceMeters).toBe(r.legs[0]!.distanceMeters + r.legs[1]!.distanceMeters);
  });
});

describe("snapping", () => {
  it("moves a pin onto the nearest road, and the route starts there", () => {
    const pin = { latitude: PLACES.balme.latitude + 0.0002, longitude: PLACES.balme.longitude };
    const snap = router.snap(pin)!;
    expect(snap.meters).toBeLessThan(MAX_SNAP_METERS);
    const r = routeOrThrow(pin, PLACES.akuafo);
    expect(r.path[0]).toEqual(snap.point);
    expect(r.snapped[0]!.meters).toBe(Math.round(snap.meters));
  });

  it("refuses a point with no campus road near it", () => {
    const kumasi = { latitude: 6.6885, longitude: -1.6244 };
    expect(router.snap(kumasi)).toBeNull();
    expect(router.route([kumasi, PLACES.balme])).toMatchObject({ code: "NO_ROAD", index: 0 });
  });

  it("says when two points have no way between them (a detached road)", () => {
    // A node outside the main network: union-find over the graph.
    const parent = Array.from({ length: router.nodeCount }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
    for (const [, , , , idx] of data.ways) for (let i = 1; i < idx.length; i++) parent[find(idx[i]!)] = find(idx[i - 1]!);
    const balme = router.snap(PLACES.balme)!;
    const mainRoot = find(data.ways[0]![4][0]!);
    const detached = Array.from({ length: router.nodeCount }, (_, i) => i).find(
      (i) => find(i) !== find(mainRoot) && find(i) !== mainRoot && haversineDistanceMeters(router.nodePoint(i), balme.point) > 50,
    );
    expect(detached).toBeDefined();
    const r = router.route([PLACES.balme, router.nodePoint(detached!)]);
    expect(r).toMatchObject({ code: "NO_ROUTE", leg: 0 });
  });
});

describe("performance", () => {
  it("routes well under 100 ms each (A* on ~3,000 points)", () => {
    const nodes = sampleNodes(600);
    const route = (k: number) => router.route([router.nodePoint(nodes[k]!), router.nodePoint(nodes[k + 1]!)]);
    // Warm up first (the JIT), then time each route. The 95th percentile, not
    // the single slowest: a parallel test run with coverage can pause any one
    // call (measured outside tests: median 0.2 ms, slowest 2 ms).
    for (let k = 0; k < 100; k += 2) route(k);
    const times: number[] = [];
    for (let k = 100; k < nodes.length; k += 2) {
      const t = performance.now();
      route(k);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const at = (q: number) => times[Math.floor(q * (times.length - 1))]!;
    expect(at(0.5)).toBeLessThan(10);
    expect(at(0.95)).toBeLessThan(50);
  });
});
