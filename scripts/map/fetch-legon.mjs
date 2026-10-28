/**
 * Fetches the roads and green areas around the University of Ghana, Legon from
 * OpenStreetMap (Overpass API) and writes them, compacted, to
 * assets/map/legon-osm.json. Two things draw them: the screenshot harness's
 * `--map-art` maps (scripts/screens/stubs/maps.tsx, which also routes cars
 * along the roads) and the website's "Where we operate" map (apps/web/build.mjs).
 * Run again only to refresh the map:
 *
 *   node scripts/map/fetch-legon.mjs
 *
 * Map data © OpenStreetMap contributors, under the Open Database Licence
 * (https://www.openstreetmap.org/copyright): anything that shows it says so.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** South, west, north, east: campus and the areas around it. */
const BBOX = [5.628, -0.205, 5.668, -0.165];

/** Road classes drawn, widest first. Each road gets its index here as its class. */
const ROAD_CLASSES = [
  ["trunk", "trunk_link", "motorway", "motorway_link"],
  ["primary", "primary_link", "secondary", "secondary_link"],
  ["tertiary", "tertiary_link", "unclassified"],
  ["residential", "living_street"],
  ["service"],
];
const GREEN = {
  leisure: /^(park|pitch|golf_course|garden)$/,
  landuse: /^(grass|forest|recreation_ground|meadow)$/,
  natural: /^(wood|scrub)$/,
};

const bbox = BBOX.join(",");
const highways = ROAD_CLASSES.flat().join("|");
const query = `[out:json][timeout:60];
(way["highway"~"^(${highways})$"](${bbox});)->.r;
(way["leisure"~"${GREEN.leisure.source}"](${bbox});
 way["landuse"~"${GREEN.landuse.source}"](${bbox});
 way["natural"~"${GREEN.natural.source}"](${bbox});
 way["natural"="water"](${bbox});)->.a;
((.r;>;);(.a;>;););out body qt;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "CampusRide-screens/1.0 (support@campusride.app)",
  },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
const { elements } = await res.json();

// Coordinates as integers of 1e-5 degrees (about a metre) to keep the file small.
const byId = new Map(elements.filter((e) => e.type === "node").map((e) => [e.id, e]));
const nodeIndex = new Map();
const nodes = [];
const at = (id) => {
  if (!nodeIndex.has(id)) {
    const n = byId.get(id);
    nodeIndex.set(id, nodes.length / 2);
    nodes.push(Math.round(n.lat * 1e5), Math.round(n.lon * 1e5));
  }
  return nodeIndex.get(id);
};

const roads = [];
const areas = [];
for (const way of elements) {
  if (way.type !== "way") continue;
  const tags = way.tags ?? {};
  if (tags.highway) {
    // Car parks' aisles and private driveways are clutter at this scale.
    if (/^(parking_aisle|driveway|drive-through)$/.test(tags.service ?? "")) continue;
    const cls = ROAD_CLASSES.findIndex((names) => names.includes(tags.highway));
    roads.push([cls, tags.oneway === "yes" ? 1 : 0, way.nodes.map(at)]);
  } else if (tags.natural === "water") {
    areas.push([1, way.nodes.map(at)]);
  } else {
    areas.push([0, way.nodes.map(at)]);
  }
}

const out = {
  attribution: "Map data © OpenStreetMap contributors (ODbL)",
  fetched: new Date().toISOString().slice(0, 10),
  bbox: BBOX,
  /** [latE5, lngE5, latE5, lngE5, …]: node i is at 2i, 2i + 1. */
  nodes,
  /** [class (ROAD_CLASSES index), oneway (1/0), node indexes]. */
  roads,
  /** [kind (0 green, 1 water), node indexes of the outline]. */
  areas,
};
const file = fileURLToPath(new URL("../../assets/map/legon-osm.json", import.meta.url));
writeFileSync(file, JSON.stringify(out) + "\n");
console.log(`${roads.length} roads, ${areas.length} areas, ${nodes.length / 2} points → ${file}`);
