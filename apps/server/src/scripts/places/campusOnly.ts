/**
 * Campus-only places (2026-10-29): put the gates where cars stop on their
 * INSIDE (CAMPUS_GATES in @rida/shared), and deactivate every other active
 * place outside the service area (J.J. Rawlings Avenue and east of it).
 *
 *   # See what would change (dry run; any database):
 *   npm run places:campus --workspace apps/server
 *
 *   # Apply to dev:
 *   npm run places:campus:dev --workspace apps/server -- --apply
 *
 *   # Production — deliberately, with the URL you export yourself:
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run places:campus --workspace apps/server -- --apply
 *
 * --apply, in one transaction:
 * 1. Each gate (by `source`): created if missing, else renamed, re-aliased
 *    and moved to its inside point (and reactivated if it was hidden).
 *    "Okponglo Gate" becomes "Stadium Gate"; "Main Gate" becomes
 *    "Main Gate (inside)". The place keeps its id, so its history stays.
 * 2. Every other active place outside the service area is deactivated
 *    (hidden from search; rides keep their own copy of the name and pin).
 *    Admin-added places too. Nothing is ever deleted.
 *
 * Idempotent: a second run finds nothing to do. Run zones:realign first so
 * moved places get the right nearest zone. The server sees the changes
 * within a minute (its place cache).
 */
import type { PlaceCategory, PrismaClient } from "@prisma/client";
import { CAMPUS_GATES, haversineDistanceMeters, isInServiceArea, nearestZone } from "@rida/shared";
import { SCRIPT_TX_OPTIONS } from "../scriptTx";

export type CampusPlaceAction =
  | { kind: "create-gate"; name: string; latitude: number; longitude: number }
  | {
      kind: "update-gate";
      name: string;
      from: { name: string; latitude: number; longitude: number; isActive: boolean };
      latitude: number;
      longitude: number;
      movedMeters: number;
    }
  | { kind: "deactivate"; name: string; latitude: number; longitude: number; source: string | null };

export interface CampusPlacesReport {
  actions: CampusPlaceAction[];
  gatesInPlace: number;
}

const sameAliases = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export async function campusOnlyPlaces(prisma: PrismaClient, apply: boolean): Promise<CampusPlacesReport> {
  return prisma.$transaction(async (tx) => {
    const zones = await tx.zone.findMany({ where: { retiredAt: null } });
    if (zones.length === 0) throw new Error("No zones in this database: seed the zones first (npm run db:seed)");
    const places = await tx.place.findMany();
    const bySource = new Map(places.filter((p) => p.source).map((p) => [p.source!, p]));
    const report: CampusPlacesReport = { actions: [], gatesInPlace: 0 };

    for (const gate of CAMPUS_GATES) {
      const { latitude, longitude } = gate.inside;
      const data = {
        name: gate.name,
        aliases: [...gate.aliases],
        latitude,
        longitude,
        category: "GATE" as PlaceCategory,
        zoneId: nearestZone(latitude, longitude, zones)!.id,
        isActive: true,
      };
      const found = bySource.get(gate.source);
      if (!found) {
        if (apply) await tx.place.create({ data: { ...data, source: gate.source } });
        report.actions.push({ kind: "create-gate", name: gate.name, latitude, longitude });
        continue;
      }
      const inPlace =
        found.name === data.name &&
        sameAliases(found.aliases, data.aliases) &&
        found.latitude === latitude &&
        found.longitude === longitude &&
        found.category === "GATE" &&
        found.isActive;
      if (inPlace) {
        report.gatesInPlace += 1;
        continue;
      }
      if (apply) await tx.place.update({ where: { id: found.id }, data });
      report.actions.push({
        kind: "update-gate",
        name: gate.name,
        from: { name: found.name, latitude: found.latitude, longitude: found.longitude, isActive: found.isActive },
        latitude,
        longitude,
        movedMeters: Math.round(haversineDistanceMeters(found, gate.inside)),
      });
    }

    const gateSources = new Set(CAMPUS_GATES.map((g) => g.source));
    for (const place of places) {
      if (!place.isActive || (place.source && gateSources.has(place.source)) || isInServiceArea(place)) continue;
      if (apply) await tx.place.update({ where: { id: place.id }, data: { isActive: false } });
      report.actions.push({
        kind: "deactivate",
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
        source: place.source,
      });
    }
    return report;
  }, SCRIPT_TX_OPTIONS);
}

const mapLink = (latitude: number, longitude: number) => `https://www.google.com/maps?q=${latitude},${longitude}`;

async function main(): Promise<void> {
  const { prisma } = await import("../../db/prisma");
  const { dbHostFromUrl } = await import("../../db/dbHostGuard");
  try {
    const apply = process.argv.includes("--apply");
    console.log(`\nCampus-only places  (database: ${dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "?"})`);
    console.log(apply ? "  APPLYING\n" : "  dry run — pass --apply to change them\n");
    const report = await campusOnlyPlaces(prisma, apply);
    for (const a of report.actions) {
      if (a.kind === "create-gate") console.log(`  add gate    ${a.name}  ${mapLink(a.latitude, a.longitude)}`);
      if (a.kind === "update-gate") {
        const was = `${a.from.name}${a.from.isActive ? "" : ", hidden"}`;
        console.log(`  move gate   ${a.name}  (was "${was}", ${a.movedMeters} m away)  ${mapLink(a.latitude, a.longitude)}`);
      }
    }
    const hide = report.actions.filter((a) => a.kind === "deactivate");
    if (hide.length) console.log(`\n  ${hide.length} place(s) outside the service area to deactivate:`);
    for (const a of hide) console.log(`  deactivate  ${a.name}  ${mapLink(a.latitude, a.longitude)}${a.source ? "" : "  (added in the admin site)"}`);
    if (report.actions.length === 0) console.log(`Everything is already in place (${report.gatesInPlace} gates): nothing to change.`);
    else if (apply) console.log("\nDone. The server shows the changes within a minute.");
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
