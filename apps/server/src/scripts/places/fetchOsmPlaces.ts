/**
 * Fetch University of Ghana places from OpenStreetMap (Overpass API) and
 * write them, curated (osmPlaces.ts), to prisma/data/campus-places.csv for
 * review. It never touches a database: the CSV is what gets reviewed,
 * committed and then seeded (seedPlaces.ts).
 *
 *   npm run places:fetch --workspace apps/server
 *
 * Two Overpass requests, a few seconds apart (Overpass asks for light use).
 * Re-running overwrites the CSV — review the diff before committing.
 *
 *   --raw <dir>   keep Overpass's answers in <dir> and reuse them next time
 *                 (for adjusting the rules in osmPlaces.ts without asking again)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { OFF_CAMPUS_ALLOWLIST, PLACES_CSV, UG_CAMPUS_WAY_ID, buildPlaceRows, toCsv, type OsmElement } from "./osmPlaces";

const OVERPASS = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const USER_AGENT = "CampusRide-places/1.0 (one-off campus place list)";

async function overpass(query: string): Promise<OsmElement[]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    if (res.ok && text.trimStart().startsWith("{")) return (JSON.parse(text) as { elements: OsmElement[] }).elements;
    console.log(`  Overpass busy (HTTP ${res.status}), retrying in ${attempt * 10}s…`);
    await new Promise((r) => setTimeout(r, attempt * 10_000));
  }
  throw new Error("Overpass didn't answer; try again later");
}

/** Overpass's answer, from `rawDir` when it has it (and saved there when it didn't). */
async function cached(rawDir: string | undefined, file: string, query: string): Promise<OsmElement[]> {
  const at = rawDir ? path.join(rawDir, file) : undefined;
  if (at && existsSync(at)) return JSON.parse(readFileSync(at, "utf8")) as OsmElement[];
  const elements = await overpass(query);
  if (at) {
    mkdirSync(rawDir!, { recursive: true });
    writeFileSync(at, JSON.stringify(elements));
  }
  return elements;
}

async function main() {
  const rawIndex = process.argv.indexOf("--raw");
  const rawDir = rawIndex === -1 ? undefined : process.argv[rawIndex + 1];

  console.log("Fetching named features inside the University of Ghana boundary…");
  const campus = await cached(
    rawDir,
    "campus.json",
    `[out:json][timeout:120];
way(${UG_CAMPUS_WAY_ID});map_to_area->.ug;
nwr(area.ug)["name"];
out tags center;`,
  );
  console.log(`  ${campus.length} named features`);

  console.log("Fetching the off-campus spots on the allowlist…");
  const ids = Object.keys(OFF_CAMPUS_ALLOWLIST).map((key) => {
    const [type, id] = key.split("/");
    return `${type}(${id});`;
  });
  let offCampus: OsmElement[] = [];
  if (ids.length > 0) {
    if (!rawDir) await new Promise((r) => setTimeout(r, 5_000));
    offCampus = await cached(rawDir, "off-campus.json", `[out:json][timeout:60];(${ids.join("")});out tags center;`);
  }
  console.log(`  ${offCampus.length} of ${ids.length} found`);

  const rows = buildPlaceRows(campus, offCampus);
  mkdirSync(path.dirname(PLACES_CSV), { recursive: true });
  writeFileSync(PLACES_CSV, toCsv(rows));
  const byCategory = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + 1 }), {});
  console.log(`\nWrote ${rows.length} places to ${path.relative(process.cwd(), PLACES_CSV)}`);
  console.log(`  ${Object.entries(byCategory).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`  ${rows.filter((r) => r.note).length} have a note to check.`);
  console.log("\nData © OpenStreetMap contributors (ODbL).");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
