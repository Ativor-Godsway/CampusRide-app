import type { Prisma, PrismaClient, Ride, RidePassenger } from "@prisma/client";
import {
  DISPATCH_WINDOW_MS,
  PRICING,
  indexRoutes,
  previewAddRider,
  type PassengerStatus,
  type PathPoint,
  type RouteLookup,
} from "@rida/shared";
import { getStoredZoneRoutes, getZoneAdjacency, getZoneMap } from "../zones/zoneCache";
import { getActivePlaces } from "../places/placeCache";
import { approximatePins } from "../places/approximatePins";
import { latestDriverPosition } from "../zones/livePositions";
import { pinFieldsOf } from "../../routes/ridePins";
import { requestFare } from "./fares";
import { FILLABLE_STATUSES } from "./assembly";
import { ACTIVE_DRIVER_STATUSES } from "./stateMachine";

/**
 * Which open requests a driver is shown and offered (shared-ride dispatch
 * rules, 2026-11). One set of rules for the Home list, the pop-up
 * broadcast, the mid-trip list and the accept itself:
 *
 * - free seats = the car's capacity − riders on board − riders assigned
 *   and still waiting for their pickup;
 * - a driver with no trip is offered any request (their car is empty, so a
 *   Ride alone fits too);
 * - a Shared car is offered Shared requests that fit its free seats AND
 *   pass the detour check the add itself makes (previewAddRider);
 * - a Ride alone car, a full car and an offline driver are offered nothing;
 * - only a Decline hides a request from that driver: a pop-up that ran out
 *   (TIMED_OUT) leaves it in their list for the rest of the search.
 */

/**
 * Every car seats four riders. There is no per-vehicle capacity yet (no
 * Driver column for it): when one is added, read it here.
 */
export const CAR_CAPACITY = PRICING.MAX_SHARED_OCCUPANCY;

export interface CarSeats {
  capacity: number;
  /** Picked up and not yet dropped off. */
  onBoard: number;
  /** In this car, not picked up yet (WAITING or ARRIVED). */
  waiting: number;
  free: number;
}

export function carSeats(passengers: readonly { status: string }[], capacity: number = CAR_CAPACITY): CarSeats {
  const onBoard = passengers.filter((p) => p.status === "PICKED_UP").length;
  const waiting = passengers.filter((p) => p.status === "WAITING" || p.status === "ARRIVED").length;
  return { capacity, onBoard, waiting, free: Math.max(0, capacity - onBoard - waiting) };
}

/** Why a request doesn't fit a driver's car (null: it fits on seats). */
export type SeatFitRefusal = "CAR_CLOSED" | "LONE_CAR" | "NEEDS_EMPTY_CAR" | "CAR_FULL" | "NOT_ENOUGH_SEATS";

/**
 * The seat half of the rules. `car` is the driver's current trip, or null
 * when they have none. `request.occupancy` is the seats asked for (1 from
 * every app and USSD today).
 */
export function seatFit(
  request: { type: string; occupancy: number },
  car: { type: string; status: string; passengers: readonly { status: string }[] } | null,
): SeatFitRefusal | null {
  if (!car) return request.occupancy <= CAR_CAPACITY ? null : "NOT_ENOUGH_SEATS";
  if (!(FILLABLE_STATUSES as readonly string[]).includes(car.status)) return "CAR_CLOSED";
  if (car.type !== "SHARED") return "LONE_CAR";
  if (request.type !== "SHARED") return "NEEDS_EMPTY_CAR";
  const { free } = carSeats(car.passengers);
  if (free === 0) return "CAR_FULL";
  return request.occupancy > free ? "NOT_ENOUGH_SEATS" : null;
}

/** Still searching: REQUESTED, nobody has it, and its window hasn't run out. */
export function openRequestWhere(now: Date): Prisma.RideWhereInput {
  return {
    status: "REQUESTED",
    driverId: null,
    broadcastStartedAt: { gte: new Date(now.getTime() - DISPATCH_WINDOW_MS) },
  };
}

/** Leaves out what this driver declined. A timed-out pop-up (TIMED_OUT) doesn't count; rows from before offers (no reason) were declines. */
export function notDeclinedBy(driverUserId: string): Prisma.RideWhereInput {
  return {
    rejections: { none: { driverUserId, OR: [{ reason: null }, { reason: { not: "TIMED_OUT" } }] } },
  };
}

/** What the detour check needs, from memory once warm. */
export interface MergeContext {
  zones: Awaited<ReturnType<typeof getZoneMap>>;
  routes: RouteLookup;
  places: Awaited<ReturnType<typeof getActivePlaces>>;
}

export async function loadMergeContext(prisma: PrismaClient): Promise<MergeContext> {
  const [zones, storedRoutes, places] = await Promise.all([
    getZoneMap(prisma),
    getStoredZoneRoutes(prisma),
    getActivePlaces(prisma),
  ]);
  return { zones, routes: indexRoutes(storedRoutes), places };
}

/** A request row as the checks read it. */
export type RequestRow = Ride & { passengers: { riderId: string; status: string; lockedFare: number | null }[] };

/**
 * The route half: would adding this request keep every rider already in
 * the car within the detour limit? Built exactly as POST /add-passenger
 * builds it, so a request shown is one the add accepts.
 */
export function passesMergeCheck(
  ctx: MergeContext,
  carPassengers: readonly RidePassenger[],
  request: RequestRow,
  from: PathPoint | null,
): boolean {
  const preview = previewAddRider({
    passengers: carPassengers.map((p) => ({
      id: p.id,
      pickupZoneId: p.pickupZoneId,
      dropoffZoneId: p.dropoffZoneId,
      lockedFare: p.lockedFare,
      status: p.status as PassengerStatus,
      ...pinFieldsOf(p),
    })),
    candidate: {
      requestRideId: request.id,
      pickupZoneId: request.pickupZoneId,
      dropoffZoneId: request.dropoffZoneId,
      farePesewas: requestFare("SHARED", request.passengers, request.riderId),
      ...approximatePins(request, ctx.zones, ctx.places),
    },
    zones: [...ctx.zones.values()],
    routes: ctx.routes,
    from,
  });
  // No preview means a zone it can't plan through: the add lets it through too.
  return !preview || preview.withinDetourLimit;
}

/** Where the driver is for the detour check: the live position, else the last one the server kept. */
export function driverPoint(
  userId: string,
  driver: { lastLat: number | null; lastLng: number | null } | null,
): PathPoint | null {
  const live = latestDriverPosition(userId, 2 * 60_000);
  if (live) return { latitude: live.latitude, longitude: live.longitude };
  return driver?.lastLat != null && driver.lastLng != null ? { latitude: driver.lastLat, longitude: driver.lastLng } : null;
}

export type CarWithPassengers = Ride & { passengers: RidePassenger[] };

/** The driver's trip under way (MATCHED/ARRIVED/IN_PROGRESS), or null. */
export async function driverCar(prisma: PrismaClient, driverUserId: string): Promise<CarWithPassengers | null> {
  return prisma.ride.findFirst({
    where: { driverId: driverUserId, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
    include: { passengers: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
}

const REQUEST_INCLUDE = {
  rider: { select: { name: true } },
  passengers: { select: { riderId: true, status: true, lockedFare: true } },
} as const;

/**
 * The open Shared requests that fit this car now — free seats and the
 * detour check — best kept in the order they came (newest first). Empty
 * for a Ride alone car, a full car, a car past taking riders, or an
 * offline driver.
 */
export async function requestsThatFitCar(
  prisma: PrismaClient,
  car: CarWithPassengers,
  driver: { userId: string; isOnline: boolean; lastLat: number | null; lastLng: number | null },
  now: Date = new Date(),
  ctx?: MergeContext,
) {
  if (!driver.isOnline) return [];
  const { free } = carSeats(car.passengers);
  if (car.type !== "SHARED" || free === 0 || !(FILLABLE_STATUSES as readonly string[]).includes(car.status)) return [];

  const inCar = new Set(car.passengers.map((p) => p.riderId));
  const rows = await prisma.ride.findMany({
    where: {
      ...openRequestWhere(now),
      ...notDeclinedBy(driver.userId),
      type: "SHARED",
      occupancy: { lte: free },
      // Demo riders only fill demo cars, real riders real cars.
      isReviewDemo: car.isReviewDemo,
    },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  const candidates = rows.filter((r) => r.id !== car.id && !inCar.has(r.riderId));
  if (candidates.length === 0) return [];
  const merge = ctx ?? (await loadMergeContext(prisma));
  const from = driverPoint(driver.userId, driver);
  return candidates.filter((r) => passesMergeCheck(merge, car.passengers, r, from));
}

/**
 * The drivers with a Shared car under way whom this request fits now
 * (seats, detour, online, not declined). Their mid-trip list shows it and
 * the broadcast reaches them; drivers with no trip are found by zone
 * (dispatch.getEligibleDrivers).
 */
export async function carsThatFitRequest(prisma: PrismaClient, request: RequestRow, now: Date = new Date()) {
  if (request.type !== "SHARED") return [];
  if (request.status !== "REQUESTED" || request.driverId !== null) return [];
  const started = request.broadcastStartedAt?.getTime() ?? 0;
  if (now.getTime() - started > DISPATCH_WINDOW_MS) return [];

  const cars = await prisma.ride.findMany({
    where: {
      status: { in: [...FILLABLE_STATUSES] },
      type: "SHARED",
      isReviewDemo: request.isReviewDemo,
      driver: {
        driver: { isOnline: true, isApproved: true },
        rideRejections: { none: { rideId: request.id, OR: [{ reason: null }, { reason: { not: "TIMED_OUT" } }] } },
      },
    },
    include: {
      passengers: { orderBy: { createdAt: "asc" } },
      driver: { select: { driver: { select: { lastLat: true, lastLng: true } } } },
    },
  });
  const fitting = cars.filter(
    (car) =>
      car.driverId !== null &&
      seatFit(request, car) === null &&
      !car.passengers.some((p) => p.riderId === request.riderId),
  );
  if (fitting.length === 0) return [];
  const ctx = await loadMergeContext(prisma);
  return fitting
    .filter((car) => passesMergeCheck(ctx, car.passengers, request, driverPoint(car.driverId!, car.driver?.driver ?? null)))
    .map((car) => car.driverId!);
}

/** The zone ids a driver in `zoneId` picks up in: that zone and the ones next to it. */
export function computeEligibleZoneSet(
  zoneId: string,
  adjacencies: Array<{ zoneId: string; adjacentZoneId: string }>,
): Set<string> {
  const zones = new Set<string>([zoneId]);
  for (const adj of adjacencies) {
    if (adj.zoneId === zoneId || adj.adjacentZoneId === zoneId) {
      zones.add(adj.zoneId);
      zones.add(adj.adjacentZoneId);
    }
  }
  return zones;
}

/**
 * The open requests a driver with no trip is offered: picked up in their
 * zone or one next to it (a review demo driver: every demo request), Ride
 * alone and Shared alike, newest first.
 */
export async function requestsForFreeDriver(
  prisma: PrismaClient,
  driver: { userId: string; currentZoneId: string | null; isReviewDemo: boolean },
  now: Date = new Date(),
) {
  if (!driver.currentZoneId && !driver.isReviewDemo) return [];
  const zones = driver.currentZoneId
    ? computeEligibleZoneSet(driver.currentZoneId, await getZoneAdjacency(prisma))
    : new Set<string>();
  return prisma.ride.findMany({
    where: {
      ...openRequestWhere(now),
      ...notDeclinedBy(driver.userId),
      occupancy: { lte: CAR_CAPACITY },
      // Demo requests for demo drivers only, real ones for real drivers only.
      isReviewDemo: driver.isReviewDemo,
      ...(driver.isReviewDemo ? {} : { pickupZoneId: { in: [...zones] } }),
    },
    // First name only, so the trip can say "Pick up Ama" from the moment
    // the driver accepts; the seat for the fare the rider was quoted.
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Every open request this driver is offered right now, whatever their
 * state: none offline, the zone list with no trip, the fitting ones for a
 * Shared car under way.
 */
export async function requestsForDriver(prisma: PrismaClient, driverUserId: string, now: Date = new Date()) {
  const [driver, car] = await Promise.all([
    prisma.driver.findUnique({
      where: { userId: driverUserId },
      select: {
        userId: true,
        isOnline: true,
        isApproved: true,
        currentZoneId: true,
        lastLat: true,
        lastLng: true,
        user: { select: { isReviewDemo: true } },
      },
    }),
    driverCar(prisma, driverUserId),
  ]);
  if (!driver || !driver.isOnline || !driver.isApproved) return [];
  if (car) return requestsThatFitCar(prisma, car, driver, now);
  return requestsForFreeDriver(prisma, { ...driver, isReviewDemo: driver.user.isReviewDemo }, now);
}
