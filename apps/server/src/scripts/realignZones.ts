/**
 * OPTIONAL: move the 15 zone centres to where those places really are.
 *
 * The zones were seeded with approximate centres packed into ~800 m; on the
 * map (OpenStreetMap) the same places spread over ~4.5 km — "Sports Stadium"
 * sits ~1.8 km from the real stadium, "Accra Mall Junction" ~3.3 km from
 * Accra Mall. Zones are invisible neighbourhoods now, so nothing breaks
 * either way, but "nearest zone to a pin" (which decides dispatch, shared
 * matching and the fallback route) is only as good as these centres.
 *
 *   # See what would move (dry run; any database):
 *   npm run zones:realign --workspace apps/server
 *
 *   # Apply to dev:
 *   npm run zones:realign:dev --workspace apps/server -- --apply
 *
 *   # Production — deliberately, with the URL you export yourself:
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run zones:realign --workspace apps/server -- --apply
 *
 * --apply moves the zones (matched by exact name; a zone not in the table is
 * left alone) and recomputes every place's zone. Afterwards re-run the zone
 * routes (npm run routes:precompute … -- --provider osrm), since they were
 * drawn between the old centres. Zone ids never change, so rides, drivers
 * and adjacency are untouched.
 */
import type { PrismaClient } from "@prisma/client";
import { haversineDistanceMeters, nearestZone } from "@rida/shared";

/** Zone name → its real position (OSM feature in the comment). */
export const REAL_ZONE_CENTRES: Record<string, { latitude: number; longitude: number; from: string }> = {
  "Main Gate": { latitude: 5.65017, longitude: -0.17896, from: "Legon Station bus stop at the main gate (node 4981090362)" },
  "Legon Hall": { latitude: 5.649374, longitude: -0.187998, from: "Legon Hall (way 427645339)" },
  "Commonwealth Hall": { latitude: 5.650804, longitude: -0.192672, from: "Commonwealth Hall (way 497853937)" },
  "Volta Hall": { latitude: 5.651496, longitude: -0.189693, from: "Volta Hall (node 5734242918)" },
  "Akuafo Hall": { latitude: 5.649357, longitude: -0.186087, from: "Akuafo Hall Main (way 421358833)" },
  "Mensah Sarbah Hall": { latitude: 5.645691, longitude: -0.186598, from: "Mensah Sarbah Hall (way 497853938)" },
  "ISH (International Students Hostel)": { latitude: 5.639769, longitude: -0.185137, from: "ISH 1 (way 278303018)" },
  "School of Business": { latitude: 5.652809, longitude: -0.188627, from: "UG Business School (node 9659866317)" },
  "Great Hall": { latitude: 5.650634, longitude: -0.196217, from: "Great Hall (way 720486436)" },
  "Balme Library": { latitude: 5.652012, longitude: -0.187048, from: "The Balme Library (relation 7304886)" },
  "Pentagon Hostel": { latitude: 5.657652, longitude: -0.182018, from: "Pentagon Block A (way 368856520)" },
  "Medical School (UGMS)": {
    latitude: 5.651852,
    longitude: -0.178107,
    from: "University of Ghana Hospital (way 278268702) — CHECK: or UG Medical Centre at 5.631864,-0.185925?",
  },
  "Sports Stadium": { latitude: 5.63903, longitude: -0.180085, from: "UG Sports Stadium (way 1273337678)" },
  "Botanical Gardens Gate": {
    latitude: 5.661431,
    longitude: -0.187923,
    from: "Botanical Gardens (way 335456879) — the gardens' centre; CHECK where the gate is",
  },
  "Accra Mall Junction": { latitude: 5.62204, longitude: -0.174733, from: "Accra Mall Roundabout bus stop (node 3045917870)" },
};

export interface RealignReport {
  moves: Array<{ name: string; meters: number; from: string }>;
  unknown: string[];
  placesRezoned: number;
}

export async function realignZones(prisma: PrismaClient, apply: boolean): Promise<RealignReport> {
  const zones = await prisma.zone.findMany();
  const report: RealignReport = { moves: [], unknown: [], placesRezoned: 0 };
  const moved = zones.map((z) => {
    const real = REAL_ZONE_CENTRES[z.name];
    if (!real) {
      report.unknown.push(z.name);
      return z;
    }
    report.moves.push({ name: z.name, meters: Math.round(haversineDistanceMeters(z, real)), from: real.from });
    return { ...z, latitude: real.latitude, longitude: real.longitude };
  });
  if (!apply) return report;

  const places = await prisma.place.findMany({ select: { id: true, latitude: true, longitude: true, zoneId: true } });
  await prisma.$transaction(async (tx) => {
    for (const z of moved) {
      await tx.zone.update({ where: { id: z.id }, data: { latitude: z.latitude, longitude: z.longitude } });
    }
    for (const p of places) {
      const zoneId = nearestZone(p.latitude, p.longitude, moved)!.id;
      if (zoneId === p.zoneId) continue;
      await tx.place.update({ where: { id: p.id }, data: { zoneId } });
      report.placesRezoned += 1;
    }
  });
  return report;
}

async function main() {
  await import("../config");
  const { prisma } = await import("../db/prisma");
  const { dbHostFromUrl } = await import("../db/dbHostGuard");
  try {
    const apply = process.argv.includes("--apply");
    console.log(`\nZone centres → real positions  (database: ${dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "?"})`);
    console.log(apply ? "  APPLYING\n" : "  dry run — pass --apply to move them\n");
    const report = await realignZones(prisma, apply);
    for (const m of report.moves.sort((a, b) => b.meters - a.meters)) {
      console.log(`  ${String(m.meters).padStart(5)} m  ${m.name}  ← ${m.from}`);
    }
    if (report.unknown.length) console.log(`\n  Left alone (not in the table): ${report.unknown.join(", ")}`);
    if (apply) {
      console.log(`\nMoved ${report.moves.length} zones; ${report.placesRezoned} places changed zone.`);
      console.log("Now re-run the zone routes: npm run routes:precompute --workspace apps/server -- --provider osrm");
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
