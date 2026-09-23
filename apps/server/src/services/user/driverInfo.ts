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
export interface DriverInfo {
  driverId: string;
  name: string;
  /**
   * The driver's phone, so a matched rider can call them at pickup
   * (Phase 4 rider<->driver contact). Only ever returned once a driver is
   * assigned to the ride, since every caller looks the driver up from
   * `ride.driverId`.
   */
  phone: string;
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
): Promise<DriverInfo | null> {
  const [driver, { _avg }] = await Promise.all([
    prisma.user.findUnique({ where: { id: driverId }, include: { driver: true } }),
    prisma.rating.aggregate({ where: { rateeId: driverId }, _avg: { stars: true } }),
  ]);
  if (!driver) return null;

  return {
    driverId: driver.id,
    name: driver.name,
    phone: driver.phone,
    carMake: driver.driver?.carMake ?? null,
    carModel: driver.driver?.carModel ?? null,
    carColor: driver.driver?.carColor ?? null,
    plate: driver.driver?.plate ?? null,
    rating: _avg.stars ?? null,
    photoUrl: driver.driver?.photoUrl ?? null,
  };
}
