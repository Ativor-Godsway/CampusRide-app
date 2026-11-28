import type { PrismaClient, RidePassenger } from "@prisma/client";
import {
  AUTO_ADD_FEATURE,
  CLIENT_FEATURES_HEADER,
  hasClientFeature,
  AUTO_ADD_UNDO_SECONDS,
  DRIVER_EVENTS,
  MOVING_OFFER_SECONDS,
  autoAddOn,
  bestMovingCar,
  firstName,
  movingCarFit,
  riderAddedText,
  seatsTaken,
  type LatLngPoint,
  type MovingFit,
  type MovingRoute,
  type RiderAddedPayload,
} from "@rida/shared";
import { logger } from "../../lib/logger";
import {
  emitDriverBroadcast,
  emitRequestsChanged,
  emitRideEvent,
  emitToDrivers,
  emitToRider,
  removeRiderFromRide,
} from "../../realtime/rideSocket";
import { isPushEnabled, sendPush } from "../push/pushService";
import { scheduleSettings } from "../scheduled/settings";
import { liveDriverWhere } from "../zones/driverLiveness";
import { addRiderToCar, FILLABLE_STATUSES } from "./assembly";
import { broadcastPayload, broadcastRide, reofferToDriver } from "./dispatch";
import { requestFare } from "./fares";
import { announceRiderAdded, detourCheck } from "./riderAdded";
import { driverPoint, loadMergeContext, passesMergeCheck, seatFit, type RequestRow } from "./requestFit";
import { movingFirstSettings } from "./searchWindow";

/**
 * Fill moving cars first (2026-11-28; rules: @rida/shared rides/movingCar.ts).
 *
 * broadcastRide runs this once for each new live Shared request (Ride.movingStep
 * still null). The best compatible moving car — a Shared trip under way with
 * a rider and a free seat for the request, live driver, adding at most the
 * scheduled-rides limits to its remaining route, least added route wins:
 * - auto-add ON (their choice, else the admin default) and an app that shows
 *   it: the rider is added at once; the driver can Undo for 15 s;
 * - otherwise an exclusive offer for 20 s: the request is held for that
 *   driver (Ride.movingHoldDriverId/Until) and hidden from everyone else.
 * Declined, expired or undone (Ride.movingStep DECLINED / EXPIRED / UNDONE):
 * normal dispatch at once. No compatible car: NONE, normal dispatch.
 */

const OFFER_MS = MOVING_OFFER_SECONDS * 1000;
const UNDO_MS = AUTO_ADD_UNDO_SECONDS * 1000;
/** The pickup estimate of an open exclusive offer, for the rider's "Pickup in about 4 min" once accepted. */
const offerEta = new Map<string, number>();

type Zones = Awaited<ReturnType<typeof loadMergeContext>>["zones"];

function pointOf(lat: number | null, lng: number | null, zoneId: string, zones: Zones): LatLngPoint | null {
  if (lat != null && lng != null) return { latitude: lat, longitude: lng };
  const z = zones.get(zoneId);
  return z ? { latitude: z.latitude, longitude: z.longitude } : null;
}

const ACTIVE = new Set(["WAITING", "ARRIVED", "PICKED_UP"]);

/** A car's remaining route from where its driver is (pickups still to do, every drop-off still to do). */
export function routeOf(passengers: readonly RidePassenger[], from: LatLngPoint | null, zones: Zones): MovingRoute | null {
  const active = passengers.filter((p) => ACTIVE.has(p.status));
  const pickups = active
    .filter((p) => p.status !== "PICKED_UP")
    .map((p) => pointOf(p.pickupLat, p.pickupLng, p.pickupZoneId, zones))
    .filter((p): p is LatLngPoint => p !== null);
  const dropoffs = active.map((p) => pointOf(p.dropoffLat, p.dropoffLng, p.dropoffZoneId, zones)).filter((p): p is LatLngPoint => p !== null);
  const start = from ?? pickups[0] ?? dropoffs[0] ?? null;
  return start ? { from: start, pickups, dropoffs } : null;
}

/** The moving cars this request could join now, each with its remaining route (seats, live, not declined, detour check). */
export async function movingCarsFor(prisma: PrismaClient, request: RequestRow, now: Date = new Date()) {
  const cars = await prisma.ride.findMany({
    where: {
      status: { in: [...FILLABLE_STATUSES] },
      type: "SHARED",
      isReviewDemo: request.isReviewDemo,
      driverId: { not: null },
      driver: {
        driver: { ...liveDriverWhere(now.getTime()), isApproved: true },
        rideRejections: { none: { rideId: request.id, OR: [{ reason: null }, { reason: { not: "TIMED_OUT" } }] } },
      },
    },
    include: {
      passengers: { orderBy: { createdAt: "asc" } },
      driver: { select: { name: true, driver: { select: { lastLat: true, lastLng: true, autoAddRiders: true, autoAddAppAt: true } } } },
    },
  });
  const moving = cars.filter(
    (car) =>
      car.passengers.some((p) => ACTIVE.has(p.status)) &&
      seatFit(request, car) === null &&
      !car.passengers.some((p) => p.riderId === request.riderId && ACTIVE.has(p.status)),
  );
  if (moving.length === 0) return [];
  const ctx = await loadMergeContext(prisma);
  const out = [];
  for (const car of moving) {
    const from = driverPoint(car.driverId!, car.driver?.driver ?? null);
    if (!passesMergeCheck(ctx, car.passengers, request, from)) continue;
    const route = routeOf(car.passengers, from, ctx.zones);
    if (route) out.push({ car, route, from });
  }
  return { cars: out, zones: ctx.zones };
}

/**
 * The moving-car step for one request. True: it was auto-added or is held
 * for one moving car (normal dispatch waits); false: dispatch as usual now.
 */
export async function runMovingCarsFirst(prisma: PrismaClient, rideId: string, now: Date = new Date()): Promise<boolean> {
  const settings = movingFirstSettings();
  if (!settings.movingFirstEnabled) return false;
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: { passengers: { select: { riderId: true, status: true, lockedFare: true } } },
  });
  if (!ride || ride.status !== "REQUESTED" || ride.driverId || ride.type !== "SHARED" || ride.isReviewDemo || ride.movingStep !== null) return false;

  const found = await movingCarsFor(prisma, ride, now);
  const cars = Array.isArray(found) ? [] : found.cars;
  const zones = Array.isArray(found) ? null : found.zones;
  const pickup = zones ? pointOf(ride.pickupLat, ride.pickupLng, ride.pickupZoneId, zones) : null;
  const dropoff = zones ? pointOf(ride.dropoffLat, ride.dropoffLng, ride.dropoffZoneId, zones) : null;
  const s = scheduleSettings();
  const best =
    pickup && dropoff
      ? bestMovingCar(
          cars.map((c) => ({ car: c, route: c.route })),
          pickup,
          dropoff,
          { maxExtraMeters: s.maxExtraMeters, maxExtraMinutes: s.maxExtraMinutes },
        )
      : null;
  if (!best) {
    await prisma.ride.updateMany({ where: { id: rideId, movingStep: null }, data: { movingStep: "NONE" } });
    return false;
  }
  const driver = best.car.car.driver?.driver;
  if (driver && autoAddOn(driver.autoAddRiders, settings.autoAddDefault) && driver.autoAddAppAt) {
    if (await autoAdd(prisma, ride, best.car, best.fit, now)) return true;
  }
  return offerExclusive(prisma, ride, best.car.car.driverId!, best.fit, now);
}

type Candidate = Exclude<Awaited<ReturnType<typeof movingCarsFor>>, never[]>["cars"][number];

/** Auto-add: into the car at once, with 15 s to Undo. False when the car can't take them after all (then: the offer). */
async function autoAdd(prisma: PrismaClient, ride: RequestRow, cand: Candidate, fit: MovingFit, now: Date): Promise<boolean> {
  const driverUserId = cand.car.driverId!;
  const { checkCar, outcome, zones } = await detourCheck(prisma, ride.id, cand.from);
  let car;
  try {
    car = await addRiderToCar(prisma, driverUserId, cand.car.id, ride.id, { acceptedVia: "AUTO", checkCar });
  } catch (err) {
    logger.info("moving first: auto-add refused, offering instead", { rideId: ride.id, reason: err instanceof Error ? err.name : "unknown" });
    return false;
  }
  if (!car.changed) return false;
  const seat = [...car.passengers].reverse().find((p) => p.riderId === ride.riderId && p.status === "WAITING");
  if (!seat) return false;
  const undoUntil = new Date(now.getTime() + UNDO_MS);
  await Promise.all([
    prisma.ridePassenger.update({ where: { id: seat.id }, data: { autoAddUndoUntil: undoUntil, movingJoinEtaMin: fit.pickupEtaMinutes } }),
    prisma.ride.update({ where: { id: ride.id }, data: { movingStep: "AUTO_ADDED", movingDetourMeters: Math.round(fit.extraMeters) } }),
  ]);

  const driverName = firstName(cand.car.driver?.name) || "Your driver";
  const rider = await prisma.user.findUnique({ where: { id: ride.riderId }, select: { name: true } });
  announceRiderAdded(prisma, {
    carId: cand.car.id,
    driverUserId,
    requestRideId: ride.id,
    outcome,
    passengers: car.passengers,
    riderPush: () => joinedPush(prisma, ride.riderId, cand.car.id, driverName, fit.pickupEtaMinutes),
  });

  const pickupLabel = seat.pickupLabel ?? zones.get(seat.pickupZoneId)?.name ?? "Pickup";
  const payload: RiderAddedPayload = {
    rideId: cand.car.id,
    passengerId: seat.id,
    firstName: firstName(rider?.name) || "Rider",
    pickupLabel,
    dropoffLabel: seat.dropoffLabel ?? zones.get(seat.dropoffZoneId)?.name ?? "Drop-off",
    seats: seat.seats,
    farePesewas: requestFare("SHARED", ride.passengers, ride.riderId),
    extraMinutes: fit.extraMinutes,
    undoUntil: undoUntil.getTime(),
    text: "",
  };
  payload.text = riderAddedText(payload);
  // The trip screen: the banner with Undo, the new stop list (it refetches on ride:status).
  emitToDrivers([driverUserId], DRIVER_EVENTS.RIDER_ADDED, payload);
  emitRideEvent(cand.car.id, "ride:status", { rideId: cand.car.id, status: car.status as never });
  // App in the background: the same words as a push.
  if (isPushEnabled()) {
    void sendPush(prisma, {
      userIds: [driverUserId],
      kind: "RIDER_ADDED",
      rideId: cand.car.id,
      text: { schedule: { title: "Rider added", body: payload.text.replace(/^Rider added · /, "") } },
      dedupeKey: `rider-added:${seat.id}`,
    });
  }
  return true;
}

/** The rider: "You've joined Kofi's car, already on the way. Pickup in about 4 min". */
function joinedPush(prisma: PrismaClient, riderId: string, carId: string, driverName: string, eta: number | null): void {
  if (!isPushEnabled()) return;
  void sendPush(prisma, {
    userIds: [riderId],
    kind: "JOINED_CAR",
    rideId: carId,
    text: { schedule: { title: `You've joined ${driverName}'s car`, body: `Already on the way.${eta !== null ? ` Pickup in about ${Math.max(1, Math.round(eta))} min.` : ""}` } },
    dedupeKey: `joined:${carId}:${riderId}`,
  });
}

/** Exclusive offer: held for this driver for 20 s (their trip screen's add pop-up), then normal dispatch. */
async function offerExclusive(prisma: PrismaClient, ride: RequestRow, driverUserId: string, fit: MovingFit, now: Date): Promise<boolean> {
  const until = new Date(now.getTime() + OFFER_MS);
  const { count } = await prisma.ride.updateMany({
    where: { id: ride.id, status: "REQUESTED", driverId: null, movingStep: null },
    data: { movingStep: "OFFERED", movingHoldDriverId: driverUserId, movingHoldUntil: until, movingDetourMeters: Math.round(fit.extraMeters) },
  });
  if (count === 0) return false;
  offerEta.set(ride.id, fit.pickupEtaMinutes);
  const full = await prisma.ride.findUnique({
    where: { id: ride.id },
    include: { pickupZone: true, dropoffZone: true, passengers: { select: { riderId: true, status: true, lockedFare: true } } },
  });
  if (full) {
    emitDriverBroadcast([driverUserId], {
      ...broadcastPayload(full, full.pickupZone.name, full.dropoffZone.name),
      expiresAt: until.getTime(),
      movingCar: { until: until.getTime(), extraMinutes: fit.extraMinutes },
    });
  }
  // The trip screen's list refetches and pops the add up with its 20 s clock.
  emitRequestsChanged(driverUserId);
  setTimeout(() => void expireHold(prisma, ride.id).catch((err) => logger.warn("moving first: expiry failed", { err })), OFFER_MS + 500).unref?.();
  return true;
}

/** The hold ran out with no answer: EXPIRED, and normal dispatch. */
export async function expireHold(prisma: PrismaClient, rideId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.ride.updateMany({
    where: { id: rideId, status: "REQUESTED", movingStep: "OFFERED", movingHoldUntil: { lte: now } },
    data: { movingStep: "EXPIRED", movingHoldDriverId: null, movingHoldUntil: null },
  });
  offerEta.delete(rideId);
  if (count > 0) await broadcastRide(prisma, rideId);
  return count > 0;
}

/** The held driver declined (or let it run out on their screen): normal dispatch at once. */
export async function releaseHold(prisma: PrismaClient, rideId: string, driverUserId: string, why: "DECLINED" | "EXPIRED"): Promise<boolean> {
  const { count } = await prisma.ride.updateMany({
    where: { id: rideId, status: "REQUESTED", movingStep: "OFFERED", movingHoldDriverId: driverUserId },
    data: { movingStep: why, movingHoldDriverId: null, movingHoldUntil: null },
  });
  offerEta.delete(rideId);
  if (count > 0) await broadcastRide(prisma, rideId);
  return count > 0;
}

/** Holds whose timer was lost (a restart): released by the timeout sweep. */
export async function sweepExpiredHolds(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const rows = await prisma.ride.findMany({
    where: { status: "REQUESTED", movingStep: "OFFERED", movingHoldUntil: { lt: new Date(now.getTime() - 2000) } },
    select: { id: true },
  });
  let n = 0;
  for (const r of rows) if (await expireHold(prisma, r.id, now)) n += 1;
  return n;
}

/** The exclusive offer was accepted (POST /add-passenger): the pickup estimate on the seat, and the "joined" push. */
export async function movingOfferAccepted(prisma: PrismaClient, carId: string, requestRideId: string, driverUserId: string): Promise<void> {
  const eta = offerEta.get(requestRideId) ?? null;
  offerEta.delete(requestRideId);
  const request = await prisma.ride.findUnique({ where: { id: requestRideId }, select: { riderId: true } });
  if (!request) return;
  // The hold itself was cleared when the rider joined the car (addRiderToCar, same UPDATE).
  const seat = await prisma.ridePassenger.findFirst({ where: { rideId: carId, riderId: request.riderId, status: "WAITING" }, orderBy: { createdAt: "desc" } });
  if (seat && eta !== null) await prisma.ridePassenger.update({ where: { id: seat.id }, data: { movingJoinEtaMin: eta } });
  const driver = await prisma.user.findUnique({ where: { id: driverUserId }, select: { name: true } });
  joinedPush(prisma, request.riderId, carId, firstName(driver?.name) || "Your driver", eta);
}

export class UndoAddError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UndoAddError";
  }
}

/**
 * The driver's Undo on an auto-added rider (within 15 s, before pickup): the
 * seat is taken off the car without penalty, the rider's request searches
 * again at once with normal dispatch (never offered to this driver again),
 * and the rider's app follows it back to the search (rebookedRideId).
 */
export async function undoAutoAdd(prisma: PrismaClient, driverUserId: string, carId: string, passengerId: string, now: Date = new Date()) {
  const seat = await prisma.ridePassenger.findFirst({ where: { id: passengerId, rideId: carId, ride: { driverId: driverUserId } } });
  if (!seat) throw new UndoAddError("NOT_FOUND", "Ride not found", 404);
  if (!seat.autoAddUndoUntil || seat.autoAddUndoUntil < now || seat.status !== "WAITING") {
    throw new UndoAddError("TOO_LATE", "It's too late to undo this. You can cancel the pickup from the stop list.", 409);
  }
  const request = await prisma.ride.findFirst({
    where: { mergedIntoRideId: carId, riderId: seat.riderId, cancelReason: "MERGED_INTO_ANOTHER_RIDE", movingStep: "AUTO_ADDED" },
    orderBy: { createdAt: "desc" },
  });
  if (!request) throw new UndoAddError("TOO_LATE", "It's too late to undo this.", 409);

  const car = await prisma.$transaction(async (tx) => {
    const { count } = await tx.ridePassenger.updateMany({
      where: { id: seat.id, status: "WAITING", autoAddUndoUntil: { gte: now } },
      data: { status: "CANCELLED", undoneRequestRideId: request.id, autoAddUndoUntil: null },
    });
    if (count === 0) throw new UndoAddError("TOO_LATE", "It's too late to undo this.", 409);
    await tx.ride.update({
      where: { id: request.id },
      data: {
        status: "REQUESTED",
        cancelReason: null,
        mergedIntoRideId: null,
        cancelledAt: null,
        matchedAt: null,
        acceptedVia: null,
        movingStep: "UNDONE",
        movingHoldDriverId: null,
        movingHoldUntil: null,
      },
    });
    await tx.rideRejection.upsert({
      where: { rideId_driverUserId: { rideId: request.id, driverUserId } },
      update: { reason: "DECLINED" },
      create: { rideId: request.id, driverUserId, reason: "DECLINED" },
    });
    const left = await tx.ridePassenger.findMany({ where: { rideId: carId } });
    return tx.ride.update({ where: { id: carId }, data: { occupancy: Math.max(1, seatsTaken(left)) } });
  });

  // The rider: back to their search, silently (GET /rides/:car says undone + rebookedRideId).
  removeRiderFromRide(seat.riderId, carId);
  emitToRider(seat.riderId, "ride:passenger_status", { rideId: carId, ridePassengerId: seat.id, riderId: seat.riderId, status: "CANCELLED" });
  emitRideEvent(request.id, "ride:status", { rideId: request.id, status: "REQUESTED" });
  emitRideEvent(carId, "ride:status", { rideId: carId, status: car.status as never });
  reofferToDriver(prisma, driverUserId);
  await broadcastRide(prisma, request.id);
  return { requestRideId: request.id };
}

// ─── The driver's app can show auto-added riders ────────────────────────────

const markedApps = new Set<string>();

/** Remembers drivers whose app sends the auto-add feature (once per server run each). */
export function installAutoAddAppMarker(app: import("fastify").FastifyInstance, prisma: PrismaClient): void {
  app.addHook("preHandler", async (request) => {
    const user = request.user;
    if (user?.role !== "DRIVER" || markedApps.has(user.userId)) return;
    if (!hasClientFeature(request.headers[CLIENT_FEATURES_HEADER], AUTO_ADD_FEATURE)) return;
    markedApps.add(user.userId);
    void prisma.driver
      .updateMany({ where: { userId: user.userId, autoAddAppAt: null }, data: { autoAddAppAt: new Date() } })
      .catch((err) => logger.warn("moving first: app marker failed", { err }));
  });
}

/** Tests only. */
export function resetAutoAddAppMarksForTests(): void {
  markedApps.clear();
}

/** How much a request adds to this car's remaining route (the board's "On your way · +3 min"), or null. */
export function addedToCar(
  car: { passengers: readonly RidePassenger[] },
  from: LatLngPoint | null,
  request: { pickupLat: number | null; pickupLng: number | null; pickupZoneId: string; dropoffLat: number | null; dropoffLng: number | null; dropoffZoneId: string },
  zones: Zones,
): MovingFit | null {
  const route = routeOf(car.passengers, from, zones);
  const pickup = pointOf(request.pickupLat, request.pickupLng, request.pickupZoneId, zones);
  const dropoff = pointOf(request.dropoffLat, request.dropoffLng, request.dropoffZoneId, zones);
  if (!route || !pickup || !dropoff) return null;
  const s = scheduleSettings();
  return movingCarFit(route, pickup, dropoff, { maxExtraMeters: s.maxExtraMeters, maxExtraMinutes: s.maxExtraMinutes });
}
