/**
 * The server's own check of where a driver is (campus-only CampusRide).
 *
 * The driver app sends its position with going online and with each zone
 * update. When it does, the SERVER decides the zone from it — the nearest
 * zone inside the service area, or none outside it — instead of trusting
 * the zone the app chose. A driver with no zone gets no requests.
 *
 * Changeover: apps from before 2026-10-29 send no position; they keep the
 * old behaviour (the zone they send is used). App Store / Google Play
 * review demo drivers are exempt: they see demo requests wherever the
 * reviewer is (services/reviewDemo).
 */
import type { PrismaClient } from "@prisma/client";
import { zoneForPoint, type LatLng } from "@rida/shared";
import { getActiveZones } from "./zoneCache";

export type DriverPosition =
  /** No position sent (an older app): use the zone it sent, as before. */
  | { kind: "none" }
  /** Sent, but ignored: a review demo driver. */
  | { kind: "exempt" }
  /** Sent and checked: the zone it is in, or null outside the service area. */
  | { kind: "checked"; point: LatLng; zoneId: string | null };

/**
 * Reads `{ latitude, longitude }` from a request body (both or neither; the
 * route schema has already checked they're numbers in range). Returns an
 * error string when only one is sent.
 */
export function parseDriverPoint(body: { latitude?: unknown; longitude?: unknown }): LatLng | null | { error: string } {
  const { latitude, longitude } = body;
  if (latitude === undefined && longitude === undefined) return null;
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: "latitude and longitude must be sent together, as numbers" };
  }
  return { latitude, longitude };
}

export async function checkDriverPosition(
  prisma: PrismaClient,
  userId: string,
  point: LatLng | null,
): Promise<DriverPosition> {
  if (!point) return { kind: "none" };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isReviewDemo: true } });
  if (user?.isReviewDemo) return { kind: "exempt" };
  const zone = zoneForPoint(point, await getActiveZones(prisma));
  return { kind: "checked", point, zoneId: zone?.id ?? null };
}

/** The columns that record a checked position (the admin live map reads them). */
export function lastPositionData(position: DriverPosition) {
  return position.kind === "checked"
    ? { lastLat: position.point.latitude, lastLng: position.point.longitude, lastSeenAt: new Date() }
    : {};
}

/** Whether the driver has a trip under way: it keeps working wherever they are. */
export async function hasActiveTrip(prisma: PrismaClient, userId: string): Promise<boolean> {
  const ride = await prisma.ride.findFirst({
    where: { driverId: userId, status: { in: ["MATCHED", "ARRIVED", "IN_PROGRESS"] } },
    select: { id: true },
  });
  return ride !== null;
}
