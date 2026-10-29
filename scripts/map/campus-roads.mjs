/**
 * The campus road graph the server routes on (services/routing in
 * apps/server, CampusRouter in @rida/shared): every drivable road inside
 * the service area, from OpenStreetMap, written to
 * assets/map/campus-roads.json.
 *
 *   node scripts/map/campus-roads.mjs                  # fetch OSM, rebuild
 *   node scripts/map/campus-roads.mjs --osm-file F     # from a saved Overpass answer
 *
 * Run it again after a change to the service area
 * (assets/map/service-area.geojson), to the gates
 * (assets/map/campus-gates.json), or to campus roads in OpenStreetMap. Then
 * run the tests (packages/shared: campusRouter.test.ts) and regenerate the
 * zone routes (docs/routing.md).
 *
 * What goes in:
 * - Drivable roads only: secondary down to service roads (parking aisles
 *   and driveways as the slowest class). No trunk road (J.J. Rawlings
 *   Avenue), no footways, nothing tagged access/motor_vehicle=no or private.
 * - Only the parts inside the service area: a segment that leaves it, even
 *   briefly, is dropped, so no route can reach a road outside.
 * - One-ways as tagged: oneway=yes/1/true, oneway=-1 (drawn backwards), and
 *   roundabouts (one-way unless oneway=no).
 * - Barriers: closed ones (assets/map/campus-gates.json, else their tags)
 *   are taken out, so no route passes them.
 *
 * Map data © OpenStreetMap contributors, under the Open Database Licence.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = here("../../assets/map/campus-roads.json");
const AREA = here("../../assets/map/service-area.geojson");
const GATES = here("../../assets/map/campus-gates.json");
const PLACES = here("../../apps/server/prisma/data/campus-places.csv");

/** Road classes, fastest first; their speeds are in @rida/shared (CAMPUS_ROAD_SPEEDS_KMH). */
const CLASSES = ["primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "service_minor"];
const CLASS_OF = {
  primary: "primary",
  primary_link: "primary",
  secondary: "secondary",
  secondary_link: "secondary",
  tertiary: "tertiary",
  tertiary_link: "tertiary",
  unclassified: "unclassified",
  road: "unclassified",
  residential: "residential",
  living_street: "living_street",
  service: "service",
};
const MINOR_SERVICE = /^(parking_aisle|driveway|drive-through)$/;
const NO_CARS = /^(no|private)$/;
const CARS_ALLOWED = /^(yes|designated|permissive|destination)$/;
const CLOSED_BARRIERS = /^(bollard|block|chain|jersey_barrier|log|rope|kerb|planter|fence|wall|turnstile|full-height_turnstile|stile|kissing_gate|cycle_barrier|motorcycle_barrier|bump_gate)$/;
const BBOX = [5.618, -0.212, 5.674, -0.17];

const RAD = Math.PI / 180;
const M_LAT = 111_320;
const M_LNG = 111_320 * Math.cos(5.65 * RAD);
const metres = (a, b) => Math.hypot((a[0] - b[0]) * M_LAT, (a[1] - b[1]) * M_LNG);

// ─── Inputs ──────────────────────────────────────────────────────────────────

async function overpass() {
  const at = process.argv.indexOf("--osm-file");
  if (at !== -1) return JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
  const highways = Object.keys(CLASS_OF).join("|");
  const query = `[out:json][timeout:120];
way["highway"~"^(${highways})$"](${BBOX.join(",")})->.w;
.w out body;
node(w.w);
out body;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "CampusRide-campus-roads/1.0 (support@campusride.app)" },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
  return res.json();
}

/** The service area as [lat, lng] (ring not repeated). */
function readArea() {
  const geo = JSON.parse(readFileSync(AREA, "utf8"));
  const ring = geo.features[0].geometry.coordinates[0].map(([lng, lat]) => [lat, lng]);
  ring.pop();
  return ring;
}

function inside(p, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Both ends inside and the segment never crossing the edge. */
function segmentInside(a, b, ring) {
  if (!inside(a, ring) || !inside(b, ring)) return false;
  for (let i = 0; i < ring.length; i++) if (crosses(a, b, ring[i], ring[(i + 1) % ring.length])) return false;
  return true;
}

function drivable(tags) {
  if (!CLASS_OF[tags.highway] || tags.area === "yes") return false;
  const carsTag = tags.motor_vehicle ?? tags.motorcar;
  if (carsTag && NO_CARS.test(carsTag)) return false;
  const general = tags.access ?? tags.vehicle;
  if (general && NO_CARS.test(general) && !(carsTag && CARS_ALLOWED.test(carsTag))) return false;
  return true;
}

function onewayOf(tags) {
  const v = tags.oneway;
  if (v === "yes" || v === "1" || v === "true") return 1;
  if (v === "-1" || v === "reverse") return -1;
  if (v === "no" || v === "false" || v === "0") return 0;
  return /^(roundabout|circular)$/.test(tags.junction ?? "") ? 1 : 0;
}

/** Closed (true) or open, and why. */
function barrierDecision(node, overrides) {
  const listed = overrides.get(node.id);
  if (listed) return { closed: !listed.open, why: `campus-gates.json: ${listed.name}` };
  const t = node.tags;
  if (CLOSED_BARRIERS.test(t.barrier)) return { closed: true, why: `barrier=${t.barrier}` };
  const carsTag = t.motor_vehicle ?? t.motorcar;
  if (carsTag && NO_CARS.test(carsTag)) return { closed: true, why: `motor_vehicle=${carsTag}` };
  if (t.access && NO_CARS.test(t.access) && !(carsTag && CARS_ALLOWED.test(carsTag))) return { closed: true, why: `access=${t.access}` };
  return { closed: false, why: `barrier=${t.barrier}${t.access ? `, access=${t.access}` : ""}` };
}

// ─── Build ───────────────────────────────────────────────────────────────────

const osm = await overpass();
const ring = readArea();
const overrides = new Map(JSON.parse(readFileSync(GATES, "utf8")).gates.map((g) => [g.osmNode, g]));
const nodeById = new Map(osm.elements.filter((e) => e.type === "node").map((n) => [n.id, n]));
const pos = (id) => {
  const n = nodeById.get(id);
  return [n.lat, n.lon];
};

const barrierReport = [];
const closedNodes = new Set();
for (const n of nodeById.values()) {
  if (!n.tags?.barrier) continue;
  if (!inside([n.lat, n.lon], ring)) continue;
  const d = barrierDecision(n, overrides);
  if (d.closed) closedNodes.add(n.id);
  barrierReport.push({ id: n.id, lat: n.lat, lng: n.lon, closed: d.closed, why: d.why });
}

const graphNodes = new Map(); // osm node id → index
const nodes = [];
const osmNodes = [];
const indexOf = (id) => {
  if (!graphNodes.has(id)) {
    graphNodes.set(id, osmNodes.length);
    const [lat, lng] = pos(id);
    nodes.push(Math.round(lat * 1e6), Math.round(lng * 1e6));
    osmNodes.push(id);
  }
  return graphNodes.get(id);
};
const names = [];
const nameIndex = new Map();
const nameOf = (name) => {
  if (!name) return -1;
  if (!nameIndex.has(name)) {
    nameIndex.set(name, names.length);
    names.push(name);
  }
  return nameIndex.get(name);
};

const ways = [];
let droppedOutside = 0;
for (const w of osm.elements) {
  if (w.type !== "way" || !drivable(w.tags ?? {})) continue;
  const tags = w.tags;
  const cls = tags.highway === "service" && MINOR_SERVICE.test(tags.service ?? "") ? "service_minor" : CLASS_OF[tags.highway];
  const oneway = onewayOf(tags);
  // Split into runs of usable segments: inside the area, not through a closed barrier.
  let run = [];
  const flush = () => {
    if (run.length >= 2) ways.push([w.id, CLASSES.indexOf(cls), oneway, nameOf(tags.name), run.map(indexOf)]);
    run = [];
  };
  for (let i = 0; i < w.nodes.length; i++) {
    const id = w.nodes[i];
    if (closedNodes.has(id)) {
      flush();
      continue;
    }
    if (run.length && !segmentInside(pos(run[run.length - 1]), pos(id), ring)) {
      droppedOutside += 1;
      flush();
    }
    if (inside(pos(id), ring)) run.push(id);
    else flush();
  }
  flush();
}

// ─── Report ──────────────────────────────────────────────────────────────────

const n = osmNodes.length;
const parent = Array.from({ length: n }, (_, i) => i);
const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
let km = 0;
for (const [, , , , idx] of ways) {
  for (let i = 1; i < idx.length; i++) {
    parent[find(idx[i])] = find(idx[i - 1]);
    km += metres([nodes[2 * idx[i - 1]] / 1e6, nodes[2 * idx[i - 1] + 1] / 1e6], [nodes[2 * idx[i]] / 1e6, nodes[2 * idx[i] + 1] / 1e6]) / 1000;
  }
}
const sizes = new Map();
for (let i = 0; i < n; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
const main = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];

const fetched = (osm.osm3s?.timestamp_osm_base ?? new Date().toISOString()).slice(0, 10);
const out = {
  attribution: "Map data © OpenStreetMap contributors (ODbL)",
  source: `OpenStreetMap, fetched ${fetched}; clipped to assets/map/service-area.geojson; gates per assets/map/campus-gates.json`,
  classes: CLASSES,
  /** [latE6, lngE6, …]: node i is at 2i, 2i + 1. */
  nodes,
  /** The OSM id of node i. */
  osmNodes,
  /** [OSM way id, class index, oneway (1 forward, -1 backward, 0 both), name index (-1 none), node indexes]. */
  ways,
  names,
  /** Every barrier inside the area: [OSM node id, 1 open / 0 closed]. */
  barriers: barrierReport.map((b) => [b.id, b.closed ? 0 : 1]),
};
writeFileSync(OUT, JSON.stringify(out) + "\n");

console.log(`${ways.length} road pieces, ${n} points, ${km.toFixed(1)} km → ${OUT}`);
console.log(`${droppedOutside} segments dropped where a road leaves the service area.`);
console.log(`Connected pieces: ${sizes.size}; the main one has ${sizes.get(main)} of ${n} points.`);
console.log(`\nBarriers inside the area (${barrierReport.length}):`);
for (const b of barrierReport.sort((a, c) => Number(c.closed) - Number(a.closed) || a.lat - c.lat)) {
  console.log(`  ${b.closed ? "CLOSED" : "open  "}  node ${b.id}  ${b.why}  https://www.google.com/maps?q=${b.lat},${b.lng}`);
}

// Places: how far each is from a road of the main piece (riders' pins snap there).
const segs = [];
for (const [, , , , idx] of ways) for (let i = 1; i < idx.length; i++) if (find(idx[i]) === main) segs.push([idx[i - 1], idx[i]]);
const P = (i) => [nodes[2 * i] / 1e6, nodes[2 * i + 1] / 1e6];
const distToSeg = (p, a, b) => {
  const [px, py, ax, ay, bx, by] = [p[1] * M_LNG, p[0] * M_LAT, a[1] * M_LNG, a[0] * M_LAT, b[1] * M_LNG, b[0] * M_LAT];
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
const far = [];
for (const line of readFileSync(PLACES, "utf8").trim().split("\n").slice(1)) {
  const c = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((s) => s.replace(/,$/, "").replace(/^"|"$/g, ""));
  const p = [Number(c[2]), Number(c[3])];
  let best = Infinity;
  for (const [a, b] of segs) best = Math.min(best, distToSeg(p, P(a), P(b)));
  if (best > 150) far.push(`  ${c[0]}: ${Math.round(best)} m from the nearest road`);
}
console.log(far.length ? `\nPlaces more than 150 m from a road of the main piece:\n${far.join("\n")}` : "\nEvery place is within 150 m of a road of the main piece.");
