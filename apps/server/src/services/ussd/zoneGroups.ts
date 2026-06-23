import type { PrismaClient, Zone } from "@prisma/client";

/**
 * USSD-only grouping layer over the 15 already-seeded Zones (prisma/seed.ts)
 * — gives a feature-phone rider a 2-tap path (group -> zone) instead of a
 * flat 15-item list. Maps by zone NAME (Zone.id is a cuid, not stable across
 * environments), confirmed against the actual seed data — every seeded zone
 * appears in exactly one group, no zone invented. No new Zone rows, no new
 * coordinates: the underlying Zone model is untouched.
 */
export const ZONE_GROUPS = {
  HALLS: [
    "Legon Hall",
    "Commonwealth Hall",
    "Volta Hall",
    "Akuafo Hall",
    "Mensah Sarbah Hall",
    "Pentagon Hostel",
  ],
  ACADEMIC: ["School of Business", "Balme Library", "Medical School (UGMS)"],
  LANDMARKS: [
    "Main Gate",
    "Sports Stadium",
    "Botanical Gardens Gate",
    "Accra Mall Junction",
    "ISH (International Students Hostel)",
    "Great Hall",
  ],
} as const;

export type ZoneGroupKey = keyof typeof ZONE_GROUPS;

export const ZONE_GROUP_ORDER: ZoneGroupKey[] = ["HALLS", "ACADEMIC", "LANDMARKS"];

export const ZONE_GROUP_LABELS: Record<ZoneGroupKey, string> = {
  HALLS: "Halls",
  ACADEMIC: "Academic",
  LANDMARKS: "Landmarks",
};

/** Validates a 1-based menu digit against ZONE_GROUP_ORDER. Returns null if out of range. */
export function zoneGroupFromMenuChoice(choice: number): ZoneGroupKey | null {
  return ZONE_GROUP_ORDER[choice - 1] ?? null;
}

/**
 * Loads the Zones in `group`, in the group's fixed display order (not DB
 * order) so the menu numbering a rider sees is stable across requests.
 * Zones missing from the DB (shouldn't happen against the real seed, but a
 * fresh/partial DB is possible in dev) are silently skipped rather than
 * breaking the menu.
 */
export async function getZonesInGroup(prisma: PrismaClient, group: ZoneGroupKey): Promise<Zone[]> {
  const names = ZONE_GROUPS[group];
  const zones = await prisma.zone.findMany({ where: { name: { in: [...names] } } });
  const byName = new Map(zones.map((z) => [z.name, z]));
  return names.map((name) => byName.get(name)).filter((z): z is Zone => z !== undefined);
}
