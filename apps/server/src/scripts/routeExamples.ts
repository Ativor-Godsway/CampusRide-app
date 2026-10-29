/**
 * Prints example campus routes to check by eye after the road graph changes:
 * distance, time, the roads driven, and two links each — Google Maps
 * directions through points of our route (Google re-plans between them, so
 * it may differ slightly), and the exact line on geojson.io.
 *
 *   npm run routes:examples --workspace apps/server
 *
 * Reads no database: places are taken from prisma/data/campus-places.csv.
 */
import { readFileSync } from "node:fs";
import { decodePolyline, encodePolyline, isCampusRouteError, type LatLng } from "@rida/shared";
import { campusRouter } from "../services/routing/campusRoutes";
import { PLACES_CSV, fromCsv } from "./places/osmPlaces";

const TRIPS: Array<[string, string]> = [
  ["Main Gate (inside)", "Balme Library"],
  ["Stadium Gate", "Commonwealth Hall"],
  ["TF Gate", "James Topp Nelson Yankah Hall"],
  ["Volta Hall", "University of Ghana Business School"],
  ["Pentagon Block A", "Akuafo Hall"],
];

const fmt = (p: LatLng) => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;

/** Google Maps directions from first to last point, through up to 8 points along the way. */
export function googleMapsLink(path: readonly LatLng[]): string {
  const inner = path.slice(1, -1);
  const step = Math.max(1, Math.ceil(inner.length / 8));
  const via = inner.filter((_, i) => i % step === Math.floor(step / 2)).slice(0, 8);
  const params = new URLSearchParams({ api: "1", origin: fmt(path[0]!), destination: fmt(path[path.length - 1]!), travelmode: "driving" });
  if (via.length) params.set("waypoints", via.map(fmt).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** The exact line, opened on geojson.io. */
export function geojsonLink(path: readonly LatLng[]): string {
  const geo = {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: path.map((p) => [Number(p.longitude.toFixed(6)), Number(p.latitude.toFixed(6))]) },
  };
  return `https://geojson.io/#data=data:application/json,${encodeURIComponent(JSON.stringify(geo))}`;
}

function main(): void {
  const places = new Map(fromCsv(readFileSync(PLACES_CSV, "utf8")).map((p) => [p.name, p]));
  const router = campusRouter();
  for (const [fromName, toName] of TRIPS) {
    const from = places.get(fromName);
    const to = places.get(toName);
    if (!from || !to) throw new Error(`not in the place list: ${!from ? fromName : toName}`);
    const started = performance.now();
    const r = router.route([from, to]);
    const ms = performance.now() - started;
    console.log(`\n${fromName} → ${toName}`);
    if (isCampusRouteError(r)) {
      console.log(`  ✗ ${r.code}: ${r.message}`);
      continue;
    }
    const roads = [...new Set(r.osmWays.map((w) => router.wayName(w)).filter(Boolean))];
    console.log(`  ${(r.distanceMeters / 1000).toFixed(2)} km, ${Math.max(1, Math.round(r.durationSeconds / 60))} min (${ms.toFixed(1)} ms)`);
    console.log(`  via: ${roads.join(" → ") || "(unnamed campus roads)"}`);
    console.log(`  Google Maps: ${googleMapsLink(r.path)}`);
    // Through the polyline the apps get, so this is exactly the line they draw.
    console.log(`  Exact line:  ${geojsonLink(decodePolyline(encodePolyline(r.path)))}`);
  }
}

main();
