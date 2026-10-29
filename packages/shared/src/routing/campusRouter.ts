/**
 * CampusRide's own route engine: the fastest drive between points on the
 * campus road graph (assets/map/campus-roads.json, built from OpenStreetMap
 * by scripts/map/campus-roads.mjs). Replaces the public OSRM server.
 *
 * - The graph only holds drivable roads inside the service area, with closed
 *   gates taken out: a route can't leave campus, use J.J. Rawlings Avenue or
 *   pass a closed gate, because those roads aren't there.
 * - One-ways are respected, including a pin partway along a one-way road.
 * - Each point is snapped to the nearest drivable road of the main road
 *   network (within MAX_SNAP_METERS): the largest part of the graph where
 *   every road can be driven to and from every other. A road cut off from
 *   the rest (a private compound, a stub at the edge of the area) or a
 *   one-way dead end (a loop whose way out was a closed gate) would leave a
 *   pin with no way anywhere. The route runs between the snapped points.
 * - No road near a point, or no way between two: an error, never a guess.
 *
 * Pure and synchronous: build one CampusRouter per graph and reuse it. A
 * route takes a few milliseconds (A* on ~3,000 points).
 */
import { haversineDistanceMeters } from "../geo/distance";
import type { LatLng } from "../driver/requestsNearYou";

/** The graph file's shape (see scripts/map/campus-roads.mjs). */
export interface CampusRoadData {
  classes: string[];
  /** [latE6, lngE6, …]: node i is at 2i, 2i + 1. */
  nodes: number[];
  osmNodes: number[];
  /** [OSM way id, class index, oneway (1 forward, -1 backward, 0 both), name index, node indexes]. */
  ways: [number, number, number, number, number[]][];
  names: string[];
  barriers?: [number, number][];
}

/** Driving speeds on campus, by road class (OSM highway). */
export const CAMPUS_ROAD_SPEEDS_KMH: Record<string, number> = {
  primary: 45,
  secondary: 40,
  tertiary: 35,
  unclassified: 30,
  residential: 25,
  living_street: 10,
  service: 20,
  /** Parking aisles, driveways. */
  service_minor: 10,
};
const DEFAULT_SPEED_KMH = 20;

/** A point further than this from every campus road isn't routed. */
export const MAX_SNAP_METERS = 300;

export interface CampusRouteLeg {
  distanceMeters: number;
  durationSeconds: number;
}

export interface CampusRoute {
  /** The road, first snapped point to last. */
  path: LatLng[];
  distanceMeters: number;
  durationSeconds: number;
  /** Leg i is points[i] → points[i + 1]. */
  legs: CampusRouteLeg[];
  /** Where each point was snapped to, and how far it was moved. */
  snapped: { point: LatLng; meters: number }[];
  /** OSM ways driven, in order (each once per stretch). */
  osmWays: number[];
  /** Graph nodes passed, in order (for checks). */
  nodePath: number[];
}

export type CampusRouteError =
  | { code: "NO_ROAD"; index: number; message: string }
  | { code: "NO_ROUTE"; leg: number; message: string };

export const NO_ROAD_MESSAGE = "That spot is too far from a campus road for a car to reach.";
export const NO_ROUTE_MESSAGE = "We couldn't find a way by car between those points on campus.";

interface Segment {
  a: number;
  b: number;
  meters: number;
  seconds: number;
  /** a → b allowed. */
  forward: boolean;
  /** b → a allowed. */
  backward: boolean;
  way: number;
}

interface Snap {
  seg: number;
  /** 0 at a, 1 at b. */
  t: number;
  point: LatLng;
  meters: number;
}

const CELL = 0.001; // degrees, ~110 m
const M_PER_DEG = 111_320;

/** A small binary min-heap of [cost, node]. */
class Heap {
  private costs: number[] = [];
  private items: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(cost: number, item: number): void {
    const { costs, items } = this;
    let i = items.length;
    costs.push(cost);
    items.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (costs[p]! <= cost) break;
      costs[i] = costs[p]!;
      items[i] = items[p]!;
      i = p;
    }
    costs[i] = cost;
    items[i] = item;
  }
  pop(): [number, number] {
    const { costs, items } = this;
    const top: [number, number] = [costs[0]!, items[0]!];
    const lastCost = costs.pop()!;
    const lastItem = items.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && costs[r]! < costs[l]! ? r : l;
        if (costs[c]! >= lastCost) break;
        costs[i] = costs[c]!;
        items[i] = items[c]!;
        i = c;
      }
      costs[i] = lastCost;
      items[i] = lastItem;
    }
    return top;
  }
}

export class CampusRouter {
  private readonly lat: Float64Array;
  private readonly lng: Float64Array;
  private readonly segments: Segment[] = [];
  /** Outgoing arcs per node: [to, segment] pairs, flattened. */
  private readonly out: number[][];
  private readonly grid = new Map<string, number[]>();
  private readonly maxSpeed: number;
  private readonly cosLat: number;

  constructor(private readonly data: CampusRoadData) {
    const n = data.nodes.length / 2;
    this.lat = new Float64Array(n);
    this.lng = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.lat[i] = data.nodes[2 * i]! / 1e6;
      this.lng[i] = data.nodes[2 * i + 1]! / 1e6;
    }
    this.cosLat = Math.cos(((this.lat[0] ?? 5.65) * Math.PI) / 180);
    this.out = Array.from({ length: n }, () => []);
    let fastest = DEFAULT_SPEED_KMH;
    data.ways.forEach(([, cls, oneway, , idx], way) => {
      const kmh = CAMPUS_ROAD_SPEEDS_KMH[data.classes[cls] ?? ""] ?? DEFAULT_SPEED_KMH;
      fastest = Math.max(fastest, kmh);
      for (let i = 1; i < idx.length; i++) {
        const a = idx[i - 1]!;
        const b = idx[i]!;
        const meters = this.metersBetween(a, b);
        const s = this.segments.length;
        const seg: Segment = { a, b, meters, seconds: meters / ((kmh * 1000) / 3600), forward: oneway >= 0, backward: oneway <= 0, way };
        this.segments.push(seg);
        if (seg.forward) this.out[a]!.push(b, s);
        if (seg.backward) this.out[b]!.push(a, s);
      }
    });
    // Only roads of the main network are snapped to.
    const main = this.mainNetwork();
    this.segments.forEach((seg, s) => {
      if (main[seg.a] && main[seg.b]) this.index(s);
    });
    this.maxSpeed = (fastest * 1000) / 3600;
  }

  /** Routes through 2 or more points, in order. */
  route(points: readonly LatLng[]): CampusRoute | CampusRouteError {
    const snaps: Snap[] = [];
    for (let i = 0; i < points.length; i++) {
      const s = this.snap(points[i]!);
      if (!s) return { code: "NO_ROAD", index: i, message: NO_ROAD_MESSAGE };
      snaps.push(s);
    }
    const path: LatLng[] = [];
    const legs: CampusRouteLeg[] = [];
    const nodePath: number[] = [];
    const osmWays: number[] = [];
    for (let i = 1; i < snaps.length; i++) {
      const leg = this.leg(snaps[i - 1]!, snaps[i]!);
      if (!leg) return { code: "NO_ROUTE", leg: i - 1, message: NO_ROUTE_MESSAGE };
      legs.push({ distanceMeters: Math.round(leg.meters), durationSeconds: Math.round(leg.seconds) });
      path.push(...(i === 1 ? leg.path : leg.path.slice(1)));
      nodePath.push(...leg.nodes);
      for (const w of leg.ways) if (osmWays[osmWays.length - 1] !== w) osmWays.push(w);
    }
    return {
      path,
      distanceMeters: legs.reduce((sum, l) => sum + l.distanceMeters, 0),
      durationSeconds: legs.reduce((sum, l) => sum + l.durationSeconds, 0),
      legs,
      snapped: snaps.map((s) => ({ point: s.point, meters: Math.round(s.meters) })),
      osmWays,
      nodePath,
    };
  }

  /** The nearest point on a drivable road, or null when none is within MAX_SNAP_METERS. */
  snap(p: LatLng): Snap | null {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return null;
    const ci = Math.floor(p.latitude / CELL);
    const cj = Math.floor(p.longitude / CELL);
    let best: Snap | null = null;
    let bestMeters = Infinity;
    const maxRing = Math.ceil(MAX_SNAP_METERS / (CELL * M_PER_DEG * this.cosLat)) + 1;
    for (let r = 0; r <= maxRing; r++) {
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          for (const s of this.grid.get(`${i},${j}`) ?? []) {
            const cand = this.project(p, s);
            if (cand.meters < bestMeters) {
              best = cand;
              bestMeters = cand.meters;
            }
          }
        }
      }
      // Anything in a further ring is at least r cells away.
      if (bestMeters <= r * CELL * M_PER_DEG * this.cosLat) break;
    }
    return bestMeters <= MAX_SNAP_METERS ? best : null;
  }

  /** The OSM way id and name of a way index (for descriptions). */
  wayName(osmWay: number): string | null {
    const w = this.data.ways.find((x) => x[0] === osmWay);
    return w && w[3] >= 0 ? this.data.names[w[3]] ?? null : null;
  }

  get nodeCount(): number {
    return this.lat.length;
  }

  nodePoint(i: number): LatLng {
    return { latitude: this.lat[i]!, longitude: this.lng[i]! };
  }

  /** Whether a move from node a to node b along one road segment is allowed. */
  allows(a: number, b: number): boolean {
    const arcs = this.out[a]!;
    for (let k = 0; k < arcs.length; k += 2) if (arcs[k] === b) return true;
    return false;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * The largest strongly connected part of the road graph (Kosaraju,
   * iterative): true for each node in it.
   */
  private mainNetwork(): Uint8Array {
    const n = this.lat.length;
    const back: number[][] = Array.from({ length: n }, () => []);
    for (let u = 0; u < n; u++) {
      const arcs = this.out[u]!;
      for (let k = 0; k < arcs.length; k += 2) back[arcs[k]!]!.push(u);
    }
    // 1. Finish order on the forward graph.
    const seen = new Uint8Array(n);
    const order: number[] = [];
    for (let start = 0; start < n; start++) {
      if (seen[start]) continue;
      seen[start] = 1;
      const stack: Array<[number, number]> = [[start, 0]];
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        const [u, k] = top;
        const arcs = this.out[u]!;
        if (k < arcs.length) {
          top[1] = k + 2;
          const v = arcs[k]!;
          if (!seen[v]) {
            seen[v] = 1;
            stack.push([v, 0]);
          }
        } else {
          order.push(u);
          stack.pop();
        }
      }
    }
    // 2. Components on the reversed graph, latest finish first.
    const comp = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    for (let i = order.length - 1; i >= 0; i--) {
      const root = order[i]!;
      if (comp[root] !== -1) continue;
      const c = sizes.length;
      let count = 0;
      const stack = [root];
      comp[root] = c;
      while (stack.length) {
        const u = stack.pop()!;
        count += 1;
        for (const v of back[u]!) {
          if (comp[v] === -1) {
            comp[v] = c;
            stack.push(v);
          }
        }
      }
      sizes.push(count);
    }
    const biggest = sizes.indexOf(Math.max(...sizes));
    return Uint8Array.from(comp, (c) => (c === biggest ? 1 : 0));
  }

  private metersBetween(a: number, b: number): number {
    return haversineDistanceMeters(this.nodePoint(a), this.nodePoint(b));
  }

  private index(s: number): void {
    const { a, b } = this.segments[s]!;
    const [i0, i1] = [Math.floor(Math.min(this.lat[a]!, this.lat[b]!) / CELL), Math.floor(Math.max(this.lat[a]!, this.lat[b]!) / CELL)];
    const [j0, j1] = [Math.floor(Math.min(this.lng[a]!, this.lng[b]!) / CELL), Math.floor(Math.max(this.lng[a]!, this.lng[b]!) / CELL)];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = `${i},${j}`;
        const cell = this.grid.get(key);
        if (cell) cell.push(s);
        else this.grid.set(key, [s]);
      }
    }
  }

  private project(p: LatLng, s: number): Snap {
    const { a, b } = this.segments[s]!;
    const kx = M_PER_DEG * this.cosLat;
    const [ax, ay, bx, by] = [this.lng[a]! * kx, this.lat[a]! * M_PER_DEG, this.lng[b]! * kx, this.lat[b]! * M_PER_DEG];
    const [px, py] = [p.longitude * kx, p.latitude * M_PER_DEG];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    const point = {
      latitude: this.lat[a]! + t * (this.lat[b]! - this.lat[a]!),
      longitude: this.lng[a]! + t * (this.lng[b]! - this.lng[a]!),
    };
    return { seg: s, t, point, meters: haversineDistanceMeters(p, point) };
  }

  /** One leg between snapped points: A* on time, from either allowed end of the start road to either allowed end of the target road. */
  private leg(from: Snap, to: Snap): { path: LatLng[]; meters: number; seconds: number; nodes: number[]; ways: number[] } | null {
    const s1 = this.segments[from.seg]!;
    const s2 = this.segments[to.seg]!;
    const way1 = this.data.ways[s1.way]![0];
    const way2 = this.data.ways[s2.way]![0];

    let best: { seconds: number; meters: number; end: number; via: number } | null = null;
    // Both on one road segment, in an allowed direction: straight along it.
    if (from.seg === to.seg && ((s1.forward && to.t >= from.t) || (s1.backward && to.t <= from.t))) {
      const f = Math.abs(to.t - from.t);
      return { path: [from.point, to.point], meters: f * s1.meters, seconds: f * s1.seconds, nodes: [], ways: [way1] };
    }

    const n = this.lat.length;
    const dist = new Float64Array(n).fill(Infinity);
    const metersTo = new Float64Array(n);
    const prev = new Int32Array(n).fill(-1);
    const prevSeg = new Int32Array(n).fill(-1);
    const heap = new Heap();
    // Never more than the real time (straight line at the top speed, to the
    // nearer end of the target road), so A* still finds the fastest route.
    const goalA = this.nodePoint(s2.a);
    const goalB = this.nodePoint(s2.b);
    const h = (i: number) => {
      const p = this.nodePoint(i);
      return Math.min(haversineDistanceMeters(p, goalA), haversineDistanceMeters(p, goalB)) / this.maxSpeed;
    };
    const closed = new Uint8Array(n);
    const start = (node: number, frac: number) => {
      const secs = frac * s1.seconds;
      if (secs < dist[node]!) {
        dist[node] = secs;
        metersTo[node] = frac * s1.meters;
        heap.push(secs + h(node), node);
      }
    };
    if (s1.forward) start(s1.b, 1 - from.t);
    if (s1.backward) start(s1.a, from.t);

    // Ways into the target: arrive at a and drive t, or at b and drive back 1 - t.
    const finishAt = new Map<number, number>();
    if (s2.forward) finishAt.set(s2.a, to.t);
    if (s2.backward) finishAt.set(s2.b, Math.min(finishAt.get(s2.b) ?? Infinity, 1 - to.t));

    while (heap.size) {
      const [f, u] = heap.pop();
      if (best && f >= best.seconds) break;
      if (closed[u]) continue;
      closed[u] = 1;
      const du = dist[u]!;
      const frac = finishAt.get(u);
      if (frac !== undefined) {
        const total = du + frac * s2.seconds;
        if (!best || total < best.seconds) best = { seconds: total, meters: metersTo[u]! + frac * s2.meters, end: u, via: frac };
      }
      const arcs = this.out[u]!;
      for (let k = 0; k < arcs.length; k += 2) {
        const v = arcs[k]!;
        const seg = this.segments[arcs[k + 1]!]!;
        const dv = du + seg.seconds;
        if (dv < dist[v]!) {
          dist[v] = dv;
          metersTo[v] = metersTo[u]! + seg.meters;
          prev[v] = u;
          prevSeg[v] = arcs[k + 1]!;
          heap.push(dv + h(v), v);
        }
      }
    }
    if (!best) return null;

    const nodes: number[] = [];
    const ways: number[] = [];
    for (let v = best.end; v !== -1; v = prev[v]!) {
      nodes.unshift(v);
      if (prevSeg[v]! >= 0) ways.unshift(this.data.ways[this.segments[prevSeg[v]!]!.way]![0]);
    }
    const path = [from.point, ...nodes.map((i) => this.nodePoint(i)), to.point];
    return {
      path,
      meters: best.meters,
      seconds: best.seconds,
      nodes,
      ways: [way1, ...ways, way2].filter((w, i, all) => i === 0 || all[i - 1] !== w),
    };
  }
}

export function isCampusRouteError(r: CampusRoute | CampusRouteError): r is CampusRouteError {
  return "code" in r;
}
