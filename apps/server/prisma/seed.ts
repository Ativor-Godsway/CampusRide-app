import { PrismaClient } from "@prisma/client";
import { assertDatabaseAllowedForEnv } from "../src/db/dbHostGuard";

/**
 * This file builds its OWN PrismaClient rather than importing src/db/prisma.ts
 * (it runs as a standalone script under ts-node, including as the seed step of
 * `prisma migrate reset`). That means it does not inherit the connection guard
 * from db/prisma.ts, so it has to run the same check itself — otherwise the
 * one command that rebuilds a database from scratch is the one command with no
 * protection at all.
 */
assertDatabaseAllowedForEnv(
  process.env.DATABASE_URL ?? "",
  process.env.NODE_ENV ?? "development",
  "prisma seed",
);

const prisma = new PrismaClient();

const zones = [
  { name: "Main Gate",                      quadrant: "SOUTH",   latitude: 5.6502, longitude: -0.1862 },
  { name: "Legon Hall",                     quadrant: "CENTRAL", latitude: 5.6523, longitude: -0.1871 },
  { name: "Commonwealth Hall",              quadrant: "CENTRAL", latitude: 5.6518, longitude: -0.1855 },
  { name: "Volta Hall",                     quadrant: "NORTH",   latitude: 5.6545, longitude: -0.1878 },
  { name: "Akuafo Hall",                    quadrant: "CENTRAL", latitude: 5.6531, longitude: -0.1863 },
  { name: "Mensah Sarbah Hall",             quadrant: "EAST",    latitude: 5.6528, longitude: -0.1843 },
  { name: "ISH (International Students Hostel)", quadrant: "WEST", latitude: 5.6519, longitude: -0.1895 },
  { name: "School of Business",             quadrant: "SOUTH",   latitude: 5.6508, longitude: -0.1879 },
  { name: "Great Hall",                     quadrant: "CENTRAL", latitude: 5.6535, longitude: -0.1869 },
  { name: "Balme Library",                  quadrant: "CENTRAL", latitude: 5.6533, longitude: -0.1874 },
  { name: "Pentagon Hostel",                quadrant: "NORTH",   latitude: 5.6551, longitude: -0.1860 },
  { name: "UG Medical Centre (UGMC)",        quadrant: "EAST",    latitude: 5.6524, longitude: -0.1830 },
  { name: "Sports Stadium",                 quadrant: "WEST",    latitude: 5.6514, longitude: -0.1900 },
  { name: "James Topp Nelson Yankah Hall (TF Hall)", quadrant: "NORTH", latitude: 5.6562, longitude: -0.1870 },
  { name: "Accra Mall Junction",            quadrant: "SOUTH",   latitude: 5.6490, longitude: -0.1856 },
];

async function main() {
  // Zones — guarded (idempotent): seed only on an empty table.
  const existingZones = await prisma.zone.count();
  if (existingZones === 0) {
    await prisma.zone.createMany({ data: zones });
    console.log(`Seeded ${zones.length} zones.`);
  } else {
    console.log(`Zones already seeded (${existingZones} found). Skipping zone seed.`);
  }

  // SEED_ZONE_ADJACENCY=false seeds zones ONLY (no adjacency). The `test` branch
  // uses this: the dispatch/assembly eligibility tests build and assert their
  // OWN sparse edges, and a pre-seeded full mesh both collides on the unique
  // constraint and breaks "distant zone is not adjacent" assumptions. Dev/prod
  // leave it unset (default true) and get the real neighbours below.
  if (process.env.SEED_ZONE_ADJACENCY === "false") {
    console.log("SEED_ZONE_ADJACENCY=false — skipping ZoneAdjacency seed (zones only).");
    return;
  }

  // Real zone neighbours (2026-11-24): pairs of zones whose areas share a
  // border, or whose centres are within 800 m (@rida/shared
  // geo/zoneNeighbours), both directions. It replaces any neighbours already
  // there between zones in service — including the old full mesh.
  const { replaceZoneNeighbours, suggestedZoneNeighbours } = await import("../src/services/zones/zoneNeighbours");
  const suggested = await suggestedZoneNeighbours(prisma);
  const { added, removed } = await replaceZoneNeighbours(prisma, suggested);
  console.log(`Zone neighbours: ${suggested.length} pairs (${added.length} added, ${removed.length} removed).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
