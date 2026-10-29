/**
 * Put the zone centres where those places really are, rename and retire
 * zones — the owner's decisions of 2026-10-12.
 *
 * The zones were seeded with approximate centres packed into ~800 m; on the
 * map (OpenStreetMap) the same places spread over ~4.5 km. Zones are
 * invisible neighbourhoods now, but "nearest zone to a pin" (dispatch,
 * shared matching, the fallback route) is only as good as these centres.
 *
 *   # See what would change (dry run; any database):
 *   npm run zones:realign --workspace apps/server
 *
 *   # Apply to dev:
 *   npm run zones:realign:dev --workspace apps/server -- --apply
 *
 *   # Production — deliberately, with the URL you export yourself:
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run zones:realign --workspace apps/server -- --apply
 *
 * --apply, in one transaction:
 * 1. RETIRES the zones in RETIRED_ZONES (sets Zone.retiredAt; the row stays
 *    for old rides). Not moved.
 * 2. RENAMES per RENAMED_ZONES, and MOVES each zone in REAL_ZONE_CENTRES to
 *    its real position. A zone in neither table is left alone (none today).
 * 3. Recomputes every place's zone over the zones in service, and moves any
 *    driver sitting in a retired zone to the in-service zone nearest it.
 *
 * Idempotent: a second run finds every zone already moved, renamed and
 * retired, and changes nothing. Zone ids never change, so rides, drivers and
 * adjacency keep pointing at the same rows. Afterwards re-run the zone routes
 * (routes:precompute), which were drawn between the old centres; it skips
 * retired zones.
 */
import type { PrismaClient, Zone } from "@prisma/client";
import { haversineDistanceMeters, nearestZone } from "@rida/shared";
import { SCRIPT_TX_OPTIONS } from "./scriptTx";

/** Off campus (Accra Mall is a future feature): kept for old rides, used for nothing new. */
export const RETIRED_ZONES = ["Accra Mall Junction"] as const;

/**
 * Old seed name → production name.  Applied in production (2026-10) and now
 * baked into prisma/seed.ts, so a fresh DB already has the right names.
 * Kept empty: the realign script no longer needs to rename anything.
 */
export const RENAMED_ZONES: Record<string, string> = {};

/** Zone (by its name AFTER renaming) → real position, from OpenStreetMap. */
export const REAL_ZONE_CENTRES: Record<string, { latitude: number; longitude: number; from: string }> = {
  // Inside the gate since 2026-10-29 (it was the Legon Station bus stop on J.J. Rawlings Avenue, now outside the area).
  "Main Gate": { latitude: 5.6503, longitude: -0.18139, from: "Main Gate (inside), on La Road behind the closed gate" },
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
  "UG Medical Centre (UGMC)": {
    latitude: 5.631864,
    longitude: -0.185925,
    from: "University of Ghana Medical Centre (way 464683570)",
  },
  "Sports Stadium": { latitude: 5.63903, longitude: -0.180085, from: "UG Sports Stadium (way 1273337678)" },
  "James Topp Nelson Yankah Hall (TF Hall)": {
    latitude: 5.666259,
    longitude: -0.182087,
    from: "James Topp Nelson Yankah Hall (way 286261174)",
  },
};

export type ZoneAction =
  | { kind: "retire"; name: string; already: boolean }
  | { kind: "move"; name: string; renamedFrom: string | null; meters: number; from: string }
  | { kind: "leave"; name: string };

export interface RealignReport {
  actions: ZoneAction[];
  placesRezoned: number;
  driversMoved: number;
}

/** True when `apply` would change nothing (every zone already in place). */
export function isAlreadyAligned(report: RealignReport): boolean {
  return report.actions.every(
    (a) => a.kind === "leave" || (a.kind === "retire" && a.already) || (a.kind === "move" && a.meters === 0 && !a.renamedFrom),
  );
}

export async function realignZones(prisma: PrismaClient, apply: boolean, now = new Date()): Promise<RealignReport> {
  const zones = await prisma.zone.findMany({ orderBy: { name: "asc" } });
  const actions: ZoneAction[] = [];
  const after: Zone[] = [];

  for (const z of zones) {
    const retire = (RETIRED_ZONES as readonly string[]).includes(z.name);
    if (retire) {
      actions.push({ kind: "retire", name: z.name, already: z.retiredAt !== null });
      after.push({ ...z, retiredAt: z.retiredAt ?? now });
      continue;
    }
    const name = RENAMED_ZONES[z.name] ?? z.name;
    const real = REAL_ZONE_CENTRES[name];
    if (!real || z.retiredAt) {
      actions.push({ kind: "leave", name: z.name });
      after.push(z);
      continue;
    }
    actions.push({
      kind: "move",
      name,
      renamedFrom: name !== z.name ? z.name : null,
      meters: Math.round(haversineDistanceMeters(z, real)),
      from: real.from,
    });
    after.push({ ...z, name, latitude: real.latitude, longitude: real.longitude });
  }

  const report: RealignReport = { actions, placesRezoned: 0, driversMoved: 0 };
  if (!apply) return report;

  const inService = after.filter((z) => z.retiredAt === null);
  const retired = after.filter((z) => z.retiredAt !== null);
  const [places, stranded] = await Promise.all([
    prisma.place.findMany({ select: { id: true, latitude: true, longitude: true, zoneId: true } }),
    prisma.driver.findMany({
      where: { currentZoneId: { in: retired.map((z) => z.id) } },
      select: { id: true, currentZoneId: true },
    }),
  ]);

  // Worked out before the transaction, so it holds only the writes: one
  // update per changed zone, then one updateMany per target zone for the
  // places and for the drivers (not one statement per row).
  const changedZones = after.filter((z) => {
    const before = zones.find((b) => b.id === z.id)!;
    return (
      before.name !== z.name ||
      before.latitude !== z.latitude ||
      before.longitude !== z.longitude ||
      (before.retiredAt === null) !== (z.retiredAt === null)
    );
  });
  const placesByZone = new Map<string, string[]>();
  for (const p of places) {
    const zoneId = nearestZone(p.latitude, p.longitude, inService)?.id;
    if (!zoneId || zoneId === p.zoneId) continue;
    placesByZone.set(zoneId, [...(placesByZone.get(zoneId) ?? []), p.id]);
    report.placesRezoned += 1;
  }
  const driversByZone = new Map<string | null, string[]>();
  for (const d of stranded) {
    const gone = retired.find((z) => z.id === d.currentZoneId)!;
    const zoneId = nearestZone(gone.latitude, gone.longitude, inService)?.id ?? null;
    driversByZone.set(zoneId, [...(driversByZone.get(zoneId) ?? []), d.id]);
    report.driversMoved += 1;
  }

  await prisma.$transaction(async (tx) => {
    for (const z of changedZones) {
      await tx.zone.update({
        where: { id: z.id },
        data: { name: z.name, latitude: z.latitude, longitude: z.longitude, retiredAt: z.retiredAt },
      });
    }
    for (const [zoneId, ids] of placesByZone) {
      await tx.place.updateMany({ where: { id: { in: ids } }, data: { zoneId } });
    }
    for (const [zoneId, ids] of driversByZone) {
      await tx.driver.updateMany({ where: { id: { in: ids } }, data: { currentZoneId: zoneId } });
    }
  }, SCRIPT_TX_OPTIONS);
  return report;
}

async function main() {
  await import("../config");
  const { prisma } = await import("../db/prisma");
  const { dbHostFromUrl } = await import("../db/dbHostGuard");
  try {
    const apply = process.argv.includes("--apply");
    console.log(`\nZones → real positions  (database: ${dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "?"})`);
    console.log(apply ? "  APPLYING\n" : "  dry run — pass --apply to change them\n");
    const report = await realignZones(prisma, apply);
    const moves = report.actions.filter((a): a is Extract<ZoneAction, { kind: "move" }> => a.kind === "move");
    for (const m of moves.sort((a, b) => b.meters - a.meters)) {
      const rename = m.renamedFrom ? `  (renamed from "${m.renamedFrom}")` : "";
      console.log(`  ${String(m.meters).padStart(5)} m  ${m.name}${rename}  ← ${m.from}`);
    }
    for (const a of report.actions) {
      if (a.kind === "retire") console.log(`  retire   ${a.name}${a.already ? "  (already retired)" : ""}`);
      if (a.kind === "leave") console.log(`  leave    ${a.name}  (no real position decided)`);
    }
    if (isAlreadyAligned(report)) console.log("\nEverything is already in place: nothing to change.");
    if (apply) {
      console.log(`\n${report.placesRezoned} places changed zone; ${report.driversMoved} drivers moved out of a retired zone.`);
      console.log("Zone routes: re-run routes:precompute only once campus-only routing is in (docs/places.md, Production order).");
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
