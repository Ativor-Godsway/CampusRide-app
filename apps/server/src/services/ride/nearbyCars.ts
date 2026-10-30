import { createHmac, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  CAR_SEATS,
  NEARBY_CARS_MAX,
  NEARBY_CAR_FRESH_MS,
  NEARBY_CAR_KEY_MS,
  NEARBY_CAR_OFFSET_M,
  haversineDistanceMeters,
  isInServiceArea,
  type LatLng,
  type NearbyCar,
} from "@rida/shared";
import { freshDriverPositions } from "../zones/livePositions";
import { ACTIVE_DRIVER_STATUSES } from "./stateMachine";
import { findActiveRideForRider } from "./activeRide";

/**
 * The cars on a rider's Home map (GET /rides/nearby-cars; rules in
 * @rida/shared rides/nearbyCars.ts): approved, online drivers with a free
 * seat, on campus, heard from in the last minute (services/zones/livePositions).
 *
 * What a rider learns is a position and a heading, nothing else:
 * - `key` is an HMAC of the driver and the current 5-minute window under a
 *   secret made at startup, so it means nothing outside this server and
 *   changes every window (a car can't be followed past it);
 * - the position is moved 10-25 m in a direction drawn from the same HMAC:
 *   fixed for the window, so the car still moves smoothly, but never exactly
 *   where it is.
 */

/** Never leaves this process; a restart simply starts new keys. */
const SECRET = randomBytes(32);

const METERS_PER_DEGREE = 111_320;

/** Which drivers can take a rider now, read at most this often (positions are fresher). */
const AVAILABLE_CACHE_MS = 5_000;
let availableCache: { ids: Set<string>; at: number } | null = null;

/** Seats still taken on a trip: the passengers not yet dropped off or cancelled. */
const LIVE_SEAT_STATUSES = new Set(["WAITING", "ARRIVED", "PICKED_UP"]);

/**
 * Approved, online drivers (real accounts: not closed, not review demo)
 * with room for a rider: no trip, or a shared trip with a seat free. A lone
 * trip is a full car.
 */
async function availableDriverIds(prisma: PrismaClient, now: number): Promise<Set<string>> {
  if (availableCache && now - availableCache.at < AVAILABLE_CACHE_MS) return availableCache.ids;
  const drivers = await prisma.driver.findMany({
    where: { isOnline: true, isApproved: true, user: { deletedAt: null, isReviewDemo: false } },
    select: { userId: true },
  });
  const ids = new Set(drivers.map((d) => d.userId));
  if (ids.size > 0) {
    const trips = await prisma.ride.findMany({
      where: { driverId: { in: [...ids] }, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
      select: { driverId: true, type: true, passengers: { select: { status: true } } },
    });
    for (const trip of trips) {
      const seats = trip.passengers.filter((p) => LIVE_SEAT_STATUSES.has(p.status)).length;
      if (trip.driverId && (trip.type !== "SHARED" || seats >= CAR_SEATS)) ids.delete(trip.driverId);
    }
  }
  availableCache = { ids, at: now };
  return ids;
}

/** The car's key and its position offset for this window. */
function disguise(userId: string, now: number): { key: string; north: number; east: number } {
  const window = Math.floor(now / NEARBY_CAR_KEY_MS);
  const digest = createHmac("sha256", SECRET).update(`${userId}:${window}`).digest();
  const angle = (digest.readUInt32BE(12) / 2 ** 32) * 2 * Math.PI;
  // Even over the ring between min and max: sqrt keeps it from bunching inward.
  const { min, max } = NEARBY_CAR_OFFSET_M;
  const u = digest.readUInt32BE(16) / 2 ** 32;
  const meters = Math.sqrt(min * min + u * (max * max - min * min));
  return { key: digest.subarray(0, 9).toString("base64url"), north: meters * Math.cos(angle), east: meters * Math.sin(angle) };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Up to NEARBY_CARS_MAX cars for this rider, nearest to `near` first (any
 * order without it). None while the rider has a ride going on: they follow
 * their own driver.
 */
export async function nearbyCars(
  prisma: PrismaClient,
  riderId: string,
  near: LatLng | null,
  now: number = Date.now(),
): Promise<NearbyCar[]> {
  const fresh = freshDriverPositions(NEARBY_CAR_FRESH_MS, now);
  for (const [userId, p] of fresh) if (!isInServiceArea(p)) fresh.delete(userId);
  // Nobody to show: no database read at all.
  if (fresh.size === 0) return [];
  if (await findActiveRideForRider(prisma, riderId)) return [];

  const available = await availableDriverIds(prisma, now);
  const cars: Array<NearbyCar & { distance: number }> = [];
  for (const [userId, p] of fresh) {
    if (!available.has(userId)) continue;
    const { key, north, east } = disguise(userId, now);
    const latitude = p.latitude + north / METERS_PER_DEGREE;
    const longitude = p.longitude + east / (METERS_PER_DEGREE * Math.cos((p.latitude * Math.PI) / 180));
    cars.push({
      key,
      latitude: round6(latitude),
      longitude: round6(longitude),
      heading: p.heading === null ? null : Math.round(p.heading),
      distance: near ? haversineDistanceMeters(near, { latitude, longitude }) : 0,
    });
  }
  return cars
    .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key))
    .slice(0, NEARBY_CARS_MAX)
    .map(({ distance: _distance, ...car }) => car);
}

/** Tests only: forget who was available. */
export function resetNearbyCarsForTests(): void {
  availableCache = null;
}
