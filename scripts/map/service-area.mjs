/**
 * The CampusRide service area: where pickups, drop-offs, pins and drivers may
 * be. Its one source is assets/map/service-area.geojson (a single polygon,
 * editable at https://geojson.io). This script turns it into
 * packages/shared/src/geo/serviceAreaPolygon.ts, which the apps, the server
 * and the admin site all use:
 *
 *   node scripts/map/service-area.mjs
 *
 * After editing the GeoJSON by hand, run that, then the tests
 * (packages/shared: serviceArea.test.ts checks every gate's inside point is
 * in the area and no point of J.J. Rawlings Avenue is).
 *
 * To rebuild the GeoJSON from OpenStreetMap (this REPLACES hand edits):
 *
 *   node scripts/map/service-area.mjs --from-osm [saved-overpass.json]
 *
 * It takes the University of Ghana campus outline (OSM way 308668766), with
 * no buffer, and keeps only the part west of J.J. Rawlings Avenue: at every
 * latitude, west of a CORRIDOR_MARGIN_M buffer around the Avenue and its
 * ramps. The Avenue and everything east of it are not served (owner's
 * decision, 2026-10-29). The approach roads between the Main and Stadium
 * gates and the Avenue are cut too (GATE_CUTS): drivers never pass a gate,
 * so the area stops just inside each gate's barrier.
 *
 * Map data © OpenStreetMap contributors, under the Open Database Licence.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GEOJSON = fileURLToPath(new URL("../../assets/map/service-area.geojson", import.meta.url));
const TS_OUT = fileURLToPath(new URL("../../packages/shared/src/geo/serviceAreaPolygon.ts", import.meta.url));

const CAMPUS_WAY_ID = 308668766;
/** How far west of the Avenue's westernmost carriageway centreline the area stops. */
const CORRIDOR_MARGIN_M = 30;
/** Ways that make up the Avenue corridor (with their ramps at the Okponglo interchange). */
const CORRIDOR = /^(J\.J\. Rawlings Avenue|Jubilee Drive|La Bawaleshi Road)$/;
const BBOX = [5.618, -0.215, 5.678, -0.16];
/**
 * Gates whose approach from the Avenue is cut: within `band` metres north or
 * south of a barrier, nothing east of `margin` metres west of it is served.
 * Barriers are OSM nodes (the lift gates on each road into campus).
 */
const GATE_CUTS = [
  // Main Gate: lift gates on both halves of Dr. J.B. Danquah Avenue (nodes 5813545126, 5813545127).
  { barriers: [[5.650495, -0.181131], [5.650782, -0.18114]], band: 25, margin: 8 },
  // Stadium Gate: lift gate (node 10649363065) and swing gate (node 1269621500) on Jubilee Drive.
  { barriers: [[5.640652, -0.180744], [5.640572, -0.179699]], band: 25, margin: 8 },
];

const RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos(5.65 * RAD);

const metres = (a, b) => Math.hypot((a[0] - b[0]) * M_PER_DEG_LAT, (a[1] - b[1]) * M_PER_DEG_LNG);

/** Douglas–Peucker on [lat, lng] points (an open line), tolerance in metres. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const [a, b] = [points[0], points[points.length - 1]];
  let worst = -1;
  let worstD = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const [ax, ay, bx, by, px, py] = [a[1] * M_PER_DEG_LNG, a[0] * M_PER_DEG_LAT, b[1] * M_PER_DEG_LNG, b[0] * M_PER_DEG_LAT, p[1] * M_PER_DEG_LNG, p[0] * M_PER_DEG_LAT];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
    if (d > worstD) [worst, worstD] = [i, d];
  }
  if (worstD <= tolerance) return [a, b];
  return [...simplify(points.slice(0, worst + 1), tolerance).slice(0, -1), ...simplify(points.slice(worst), tolerance)];
}

async function overpass(savedFile) {
  if (savedFile) return JSON.parse(readFileSync(savedFile, "utf8"));
  const query = `[out:json][timeout:90];
way(${CAMPUS_WAY_ID});out geom;
way["highway"~"^(trunk|trunk_link)$"]["name"](${BBOX.join(",")});out geom tags;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "CampusRide-service-area/1.0 (support@campusride.app)" },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
  return res.json();
}

/** The campus outline west of the Avenue corridor, as a closed ring of [lat, lng]. */
function cutCampus(osm) {
  const campusWay = osm.elements.find((e) => e.type === "way" && e.id === CAMPUS_WAY_ID);
  if (!campusWay) throw new Error(`OSM way ${CAMPUS_WAY_ID} (the campus) is missing`);
  const outline = campusWay.geometry.map((g) => [g.lat, g.lon]);
  if (metres(outline[0], outline[outline.length - 1]) < 0.01) outline.pop();

  const corridor = osm.elements.filter(
    (e) => e.type === "way" && /^(trunk|trunk_link)$/.test(e.tags?.highway ?? "") && CORRIDOR.test(e.tags?.name ?? ""),
  );
  if (corridor.length < 10) throw new Error(`only ${corridor.length} J.J. Rawlings Avenue ways found`);
  const segments = corridor.flatMap((w) => w.geometry.slice(1).map((g, i) => [w.geometry[i], g]));

  // The cut's longitude at each latitude (every ~2 m): the west edge of a
  // CORRIDOR_MARGIN_M buffer around the corridor (every point of it, so a ramp
  // running east–west keeps its margin to the north and south too), and of
  // each gate cut. Latitudes beyond the corridor take the nearest known value.
  const lat0 = BBOX[0];
  const step = 0.00002;
  const rows = Math.round((BBOX[2] - lat0) / step) + 1;
  const west = new Array(rows).fill(Infinity);
  const reach = (lat, lng, radius) => {
    const span = Math.ceil(radius / M_PER_DEG_LAT / step);
    const row = Math.round((lat - lat0) / step);
    for (let r = Math.max(0, row - span); r <= Math.min(rows - 1, row + span); r++) {
      const dy = (lat0 + r * step - lat) * M_PER_DEG_LAT;
      if (Math.abs(dy) > radius) continue;
      west[r] = Math.min(west[r], lng - Math.sqrt(radius * radius - dy * dy) / M_PER_DEG_LNG);
    }
  };
  for (const [a, b] of segments) {
    const n = Math.max(1, Math.ceil(metres([a.lat, a.lon], [b.lat, b.lon]) / 2));
    for (let s = 0; s <= n; s++) reach(a.lat + ((b.lat - a.lat) * s) / n, a.lon + ((b.lon - a.lon) * s) / n, CORRIDOR_MARGIN_M);
  }
  const known = west.map((lng, i) => [i, lng]).filter(([, lng]) => Number.isFinite(lng));
  for (let i = 0; i < rows; i++) {
    if (Number.isFinite(west[i])) continue;
    west[i] = known.reduce((best, k) => (Math.abs(k[0] - i) < Math.abs(best[0] - i) ? k : best))[1];
  }
  for (const { barriers, band, margin } of GATE_CUTS) {
    for (const [lat, lng] of barriers) {
      const span = Math.ceil(band / M_PER_DEG_LAT / step);
      const row = Math.round((lat - lat0) / step);
      for (let r = Math.max(0, row - span); r <= Math.min(rows - 1, row + span); r++) {
        west[r] = Math.min(west[r], lng - margin / M_PER_DEG_LNG);
      }
    }
  }
  const cutLng = (lat) => west[Math.max(0, Math.min(rows - 1, Math.round((lat - lat0) / step)))];

  // Densify (so the cut is placed to within a few metres), then keep what's west of the cut.
  const dense = [];
  for (let i = 0; i < outline.length; i++) {
    const [a, b] = [outline[i], outline[(i + 1) % outline.length]];
    const n = Math.max(1, Math.ceil(metres(a, b) / 3));
    for (let s = 0; s < n; s++) dense.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  const side = (p) => p[1] - cutLng(p[0]);
  const ring = [];
  for (let i = 0; i < dense.length; i++) {
    const [a, b] = [dense[i], dense[(i + 1) % dense.length]];
    const [sa, sb] = [side(a), side(b)];
    if (sa < 0) ring.push({ p: a });
    if (sa < 0 !== sb < 0) {
      const t = sa / (sa - sb);
      ring.push({ p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], leaving: sa < 0 });
    }
  }
  // Where the outline leaves the west side and comes back, the new edge follows the cut line.
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    out.push(ring[i].p);
    const next = ring[(i + 1) % ring.length];
    if (ring[i].leaving && next.leaving === false) {
      const [from, to] = [ring[i].p[0], next.p[0]];
      const n = Math.ceil(Math.abs(to - from) / step);
      for (let s = 1; s < n; s++) {
        const lat = from + ((to - from) * s) / n;
        out.push([lat, cutLng(lat)]);
      }
    }
  }
  // Simplify as an open line from the westernmost point (it stays put), then close.
  const start = out.reduce((best, p, i) => (p[1] < out[best][1] ? i : best), 0);
  const line = [...out.slice(start), ...out.slice(0, start), out[start]];
  return simplify(line, 1.5).slice(0, -1);
}

function toGeoJson(ring, fetched) {
  const coordinates = [...ring, ring[0]].map(([lat, lng]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          name: "CampusRide service area",
          description:
            `University of Ghana campus outline (OSM way ${CAMPUS_WAY_ID}, no buffer), west of J.J. Rawlings Avenue: ` +
            `the Avenue, its ramps and everything east of it are excluded, with a ${CORRIDOR_MARGIN_M} m margin, ` +
            "and so are the Main and Stadium gates' approach roads east of their barriers.",
          source: `OpenStreetMap, fetched ${fetched}`,
          attribution: "Map data © OpenStreetMap contributors (ODbL)",
        },
        geometry: { type: "Polygon", coordinates: [coordinates] },
      },
    ],
  };
}

/** The GeoJSON's single polygon as [lat, lng] points (ring not repeated). */
function readRing() {
  const geo = JSON.parse(readFileSync(GEOJSON, "utf8"));
  const polygons = (geo.features ?? [geo]).filter((f) => f.geometry?.type === "Polygon");
  if (polygons.length !== 1) throw new Error(`${GEOJSON}: expected exactly one Polygon, found ${polygons.length}`);
  const [outer, ...holes] = polygons[0].geometry.coordinates;
  if (holes.length) throw new Error(`${GEOJSON}: holes aren't supported (draw the shape around them instead)`);
  const ring = outer.map(([lng, lat]) => [lat, lng]);
  if (metres(ring[0], ring[ring.length - 1]) < 0.01) ring.pop();
  if (ring.length < 3) throw new Error(`${GEOJSON}: the polygon needs at least 3 points`);
  return { ring, source: polygons[0].properties?.source ?? "" };
}

function writeTs({ ring, source }) {
  const rows = ring.map(([lat, lng]) => `  [${lat.toFixed(6)}, ${lng.toFixed(6)}],`).join("\n");
  writeFileSync(
    TS_OUT,
    `// GENERATED by scripts/map/service-area.mjs from assets/map/service-area.geojson — don't edit by hand.
// ${source}. Map data © OpenStreetMap contributors (ODbL).
import type { PolygonPoint } from "./serviceArea";

/** [latitude, longitude], in order around the edge (${ring.length} points). */
export const SERVICE_AREA_POLYGON: readonly PolygonPoint[] = [
${rows}
];
`,
  );
  console.log(`${ring.length} points → ${TS_OUT}`);
}

const fromOsm = process.argv.indexOf("--from-osm");
if (fromOsm !== -1) {
  const saved = process.argv[fromOsm + 1];
  const osm = await overpass(saved && !saved.startsWith("--") ? saved : undefined);
  const fetched = (osm.osm3s?.timestamp_osm_base ?? new Date().toISOString()).slice(0, 10);
  const ring = cutCampus(osm);
  writeFileSync(GEOJSON, JSON.stringify(toGeoJson(ring, fetched), null, 2) + "\n");
  console.log(`${ring.length} points → ${GEOJSON}`);
}
writeTs(readRing());
