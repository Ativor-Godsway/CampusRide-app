import type { PrismaClient } from "@prisma/client";
import {
  RIDE_EVENTS,
  USUAL_WAIT_DAYS,
  USUAL_WAIT_MIN_SAMPLES,
  roundToHundredMeters,
  usualWaitRange,
  type LatLng,
  type RideSearchStatus,
  type SearchScope,
  type SearchWaitRange,
} from "@rida/shared";
import { emitToRider, hasSocketServer } from "../../realtime/rideSocket";
import { logger } from "../../lib/logger";
import { liveDriverWhere } from "../zones/driverLiveness";
import { getZoneAdjacency, getZoneMap } from "../zones/zoneCache";
import { carsNear } from "./nearbyCars";
import { computeEligibleZoneSet, openRequestWhere } from "./requestFit";
import { dispatchPlan } from "./dispatch";
import { noteSearchDispatched, searchProgress } from "./searchProgress";
import { ACTIVE_DRIVER_STATUSES } from "./stateMachine";
import { waitFeeSettings } from "./waitFee";

/**
 * The rider's "Finding your driver" screen (@rida/shared rides/searchStatus):
 * what the search for this ride is really doing. GET /rides/:id/search-status
 * answers it, and `ride:search_status` brings it to the rider's own room as
 * soon as dispatch acts, so "Shown to 3 drivers nearby" is there within a
 * second of the request.
 *
 * Every number is real: who dispatch offered it to and who declined
 * (services/ride/searchProgress, memory), live drivers' positions (memory),
 * the database for the rest — a few small reads, the slow ones cached.
 *
 * Private: counts and distances only. The cars for the map are the Home
 * map's (services/ride/nearbyCars: a key that changes every 5 minutes, a
 * position moved 10-25 m) — never a driver id, name or exact position.
 */

/** "Usually 1–3 min" is worked out again at most this often. */
const USUAL_WAIT_CACHE_MS = 10 * 60_000;
/** Who is busy on a trip, read at most this often. */
const ON_TRIP_CACHE_MS = 10_000;

let usualWaitCache: { at: number; value: SearchWaitRange | null } | null = null;
let onTripCache: { at: number; zoneIds: Array<string | null> } | null = null;

/**
 * Median and 75th percentile time from request to a driver's accept (a
 * claim, or being added to a car — both stamp matchedAt), over the last 7
 * days of real requests. Null with fewer than USUAL_WAIT_MIN_SAMPLES.
 */
export async function usualWait(prisma: PrismaClient, now: number = Date.now()): Promise<SearchWaitRange | null> {
  if (usualWaitCache && now - usualWaitCache.at < USUAL_WAIT_CACHE_MS) return usualWaitCache.value;
  const since = new Date(now - USUAL_WAIT_DAYS * 24 * 60 * 60_000);
  const until = new Date(now);
  try {
    const [row] = await prisma.$queryRaw<Array<{ n: number; median: number | null; p75: number | null }>>`
      SELECT count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY s) AS p75
      FROM (
        SELECT EXTRACT(EPOCH FROM ("matchedAt" - "createdAt"))::float8 AS s
        FROM "Ride"
        WHERE "isReviewDemo" = false AND "matchedAt" IS NOT NULL
          AND "createdAt" >= ${since} AND "createdAt" < ${until}
      ) t
      WHERE s >= 0`;
    const value =
      row && row.n >= USUAL_WAIT_MIN_SAMPLES && row.median !== null && row.p75 !== null
        ? usualWaitRange(Number(row.median), Number(row.p75))
        : null;
    usualWaitCache = { at: now, value };
    return value;
  } catch (err) {
    logger.warn("search status: usual wait failed", { err });
    return usualWaitCache?.value ?? null;
  }
}

/** The zones of live drivers busy on a trip right now (null: zone not known). */
async function onTripZones(prisma: PrismaClient, now: number): Promise<Array<string | null>> {
  if (onTripCache && now - onTripCache.at < ON_TRIP_CACHE_MS) return onTripCache.zoneIds;
  const trips = await prisma.ride.findMany({
    where: {
      status: { in: [...ACTIVE_DRIVER_STATUSES] },
      isReviewDemo: false,
      driver: { driver: { ...liveDriverWhere(now), isApproved: true } },
    },
    select: { driver: { select: { driver: { select: { currentZoneId: true } } } } },
  });
  const zoneIds = trips.map((t) => t.driver?.driver?.currentZoneId ?? null);
  onTripCache = { at: now, zoneIds };
  return zoneIds;
}

type SearchingRide = {
  id: string;
  riderId: string;
  status: string;
  driverId: string | null;
  isReviewDemo: boolean;
  createdAt: Date;
  broadcastStartedAt: Date | null;
  pickupZoneId: string;
  pickupLat: number | null;
  pickupLng: number | null;
};

/**
 * The status of a ride still searching, or null when it isn't (taken,
 * cancelled, out of time).
 */
export async function searchStatusOf(
  prisma: PrismaClient,
  rideId: string,
  now: number = Date.now(),
): Promise<{ riderId: string; status: RideSearchStatus } | null> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: { passengers: { select: { riderId: true, status: true, lockedFare: true } } },
  });
  if (!ride || ride.status !== "REQUESTED" || ride.driverId !== null) return null;
  return { riderId: ride.riderId, status: await buildStatus(prisma, ride, now) };
}

async function buildStatus(
  prisma: PrismaClient,
  ride: SearchingRide & Parameters<typeof dispatchPlan>[1],
  now: number,
): Promise<RideSearchStatus> {
  const started = ride.broadcastStartedAt ?? ride.createdAt;
  // This server saw the search start (it almost always did); else, after a
  // restart, what dispatch's rules offer it to now — the drivers' lists.
  const progress =
    searchProgress(ride.id, started.getTime()) ??
    noteSearchDispatched(ride.id, started.getTime(), await dispatchPlan(prisma, ride), now);
  const withIt = [...progress.offered].filter((id) => !progress.declined.has(id)).length;

  const [zones, adjacency] = await Promise.all([getZoneMap(prisma), getZoneAdjacency(prisma)]);
  const zone = zones.get(ride.pickupZoneId);
  const pickup: LatLng | null =
    ride.pickupLat !== null && ride.pickupLng !== null
      ? { latitude: ride.pickupLat, longitude: ride.pickupLng }
      : zone
        ? { latitude: zone.latitude, longitude: zone.longitude }
        : null;
  const nearZones = computeEligibleZoneSet(ride.pickupZoneId, adjacency);

  const [cars, busyZones, olderNearby, wait] = await Promise.all([
    // Review demo searches see no real cars.
    ride.isReviewDemo ? Promise.resolve({ cars: [], nearestMeters: null }) : carsNear(prisma, pickup, now, progress.declined),
    ride.isReviewDemo ? Promise.resolve([]) : onTripZones(prisma, now),
    prisma.ride.count({
      where: {
        ...openRequestWhere(new Date(now)),
        id: { not: ride.id },
        isReviewDemo: ride.isReviewDemo,
        pickupZoneId: { in: [...nearZones] },
        createdAt: { lt: ride.createdAt },
      },
    }),
    usualWait(prisma, now),
  ]);

  const driversOnTrips: SearchScope | null =
    busyZones.length === 0 ? null : busyZones.some((z) => z !== null && nearZones.has(z)) ? "nearby" : "campus";
  const { freeWaitSeconds } = waitFeeSettings();

  return {
    rideId: ride.id,
    searchStartedAt: started.toISOString(),
    driversOffered: progress.offered.size,
    driversWithIt: withIt,
    scope: progress.scope,
    carsChecked: progress.carsChecked,
    nearestFreeCarMeters: cars.nearestMeters === null ? null : roundToHundredMeters(cars.nearestMeters),
    driversOnTrips,
    firstInLine: olderNearby === 0,
    usualWait: wait,
    freeWaitSeconds,
    cars: cars.cars,
  };
}

/** At most one push per search this often; a change inside it goes out at its end. */
const PUSH_EVERY_MS = 2_000;
const lastPushed = new Map<string, number>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Sends the rider the status of their search (`ride:search_status`, their
 * own room). Called when dispatch acts on it. Fire-and-forget: never throws.
 */
export function pushSearchStatus(prisma: PrismaClient, rideId: string, now: number = Date.now()): void {
  // No socket server (route tests, scripts): nobody to send it to.
  if (!hasSocketServer() || pending.has(rideId)) return;
  const wait = Math.max(0, (lastPushed.get(rideId) ?? 0) + PUSH_EVERY_MS - now);
  const send = () => {
    pending.delete(rideId);
    lastPushed.set(rideId, Date.now());
    if (lastPushed.size > 2_000) {
      const oldest = lastPushed.keys().next().value;
      if (oldest !== undefined) lastPushed.delete(oldest);
    }
    searchStatusOf(prisma, rideId).then(
      (found) => {
        if (found) emitToRider(found.riderId, RIDE_EVENTS.SEARCH_STATUS, found.status);
      },
      (err) => logger.warn("search status push failed", { rideId, err }),
    );
  };
  if (wait === 0) {
    // Still one tick later, so a broadcast's own writes come first.
    const timer = setTimeout(send, 0);
    timer.unref?.();
    pending.set(rideId, timer);
    return;
  }
  const timer = setTimeout(send, wait);
  timer.unref?.();
  pending.set(rideId, timer);
}

/** Tests only. */
export function resetSearchStatusForTests(): void {
  usualWaitCache = null;
  onTripCache = null;
  lastPushed.clear();
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}
