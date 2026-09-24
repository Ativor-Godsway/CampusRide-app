import type { PrismaClient } from "@prisma/client";

/**
 * Driver info shaped like the `ride:driver_assigned` socket payload (minus
 * rideId) — used for that event, for GET /rides/:id so a rider who reconnects
 * sees the same shape, and by the driver-side claim response.
 *
 * Extracted in Phase 4: routes/rides.ts and routes/driver.ts each carried a
 * byte-identical private copy, so a change to the rider-facing driver payload
 * had to be made twice and could silently drift between the socket event and
 * the REST fallback.
 */
/**
 * How long after a ride completes the driver's number stays visible to the
 * rider. Long enough to cover "I left my bag in the car" the next morning,
 * short enough that a months-old trip is not a standing line to a stranger.
 */
export const DRIVER_CONTACT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the driver's phone should still be shown for a ride completed at
 * `completedAt`.
 *
 * A ride that has not completed is in progress, so the number is always
 * visible — that is the case the call button exists for.
 */
export function isDriverContactVisible(
  completedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!completedAt) return true;
  return now.getTime() - completedAt.getTime() < DRIVER_CONTACT_TTL_MS;
}

export interface DriverInfo {
  driverId: string;
  name: string;
  /**
   * The driver's phone, so a matched rider can call them at pickup
   * (Phase 4 rider<->driver contact).
   *
   * Null once the ride has been finished for longer than
   * DRIVER_CONTACT_TTL_MS — the trip that justified sharing the number is
   * over, so the number goes away with it.
   */
  phone: string | null;
  carMake: string | null;
  carModel: string | null;
  carColor: string | null;
  plate: string | null;
  /** Average of the driver's past ratings, or null if they have none yet. */
  rating: number | null;
  photoUrl: string | null;
}

export async function getDriverInfo(
  prisma: PrismaClient,
  driverId: string,
  /**
   * The ride this driver is being looked up for. Omit for a ride that is
   * still running (the claim path), where the number is always visible.
   */
  ride?: { completedAt: Date | null },
  now: Date = new Date(),
): Promise<DriverInfo | null> {
  const [driver, { _avg }] = await Promise.all([
    prisma.user.findUnique({ where: { id: driverId }, include: { driver: true } }),
    prisma.rating.aggregate({ where: { rateeId: driverId }, _avg: { stars: true } }),
  ]);
  if (!driver) return null;

  return {
    driverId: driver.id,
    name: driver.name,
    phone: isDriverContactVisible(ride?.completedAt, now) ? driver.phone : null,
    carMake: driver.driver?.carMake ?? null,
    carModel: driver.driver?.carModel ?? null,
    carColor: driver.driver?.carColor ?? null,
    plate: driver.driver?.plate ?? null,
    rating: _avg.stars ?? null,
    photoUrl: driver.driver?.photoUrl ?? null,
  };
}
