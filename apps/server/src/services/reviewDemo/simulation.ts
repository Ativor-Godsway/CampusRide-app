import type { PrismaClient, Ride, RidePassenger } from "@prisma/client";
import {
  RIDE_EVENTS,
  decodePolyline,
  haversineDistanceMeters,
  pathLengthMeters,
  pointAlongPath,
  type PathPoint,
} from "@rida/shared";
import { logger } from "../../lib/logger";
import { emitRideEvent } from "../../realtime/rideSocket";
import { checkDriverArriving } from "../push/notify";
import { estimateRoute } from "../routing/campusRoutes";
import { getZoneMap } from "../zones/zoneCache";
import { applyPassengerTransition, applyRideTransition } from "../ride/rideService";
import { createRide } from "../ride/createRide";
import { claimIfOpen, closeOffer } from "../ride/dispatch";
import { announceClaim, announcePassengerChange } from "../ride/driverActionEvents";
import { ACTIVE_RIDE_STATUSES } from "../ride/createRide";
import { ensureDemoAccount, SIM_RIDER_PHONE } from "./accounts";
import { reviewDemoConfig } from "./config";

/**
 * The review demo's simulated people (services/reviewDemo/config.ts).
 *
 * - A demo rider's request is accepted within seconds by a simulated driver,
 *   who drives the real route to the pickup, arrives, starts the trip, drives
 *   to the drop-off and completes it: every rider screen, with live position.
 * - While the demo driver is online, a simulated rider requests a ride about
 *   once a minute, offered to demo drivers only; the reviewer accepts it and
 *   runs the trip from the driver app as usual.
 *
 * Everything goes through the same code real drivers use (claim, passenger
 * steps, the events and notifications riders get), on rides flagged
 * isReviewDemo that real people never see. The demo switched off
 * (REVIEW_DEMO_ENABLED) stops every simulation.
 */

export interface DemoTiming {
  /** Until the simulated driver accepts. */
  claimDelayMs: number;
  /** Between position updates while driving. */
  stepMs: number;
  /** Position updates on the way to the pickup (×stepMs ≈ the drive). */
  approachSteps: number;
  /** Waiting at the pickup before starting the trip. */
  waitAtPickupMs: number;
  /** Position updates on the trip itself. */
  tripSteps: number;
  /** A new simulated request for the demo driver at most this often. */
  requestEveryMs: number;
  /** An unanswered simulated request is withdrawn after this. */
  requestExpireMs: number;
  /** How often the request loop looks. */
  tickMs: number;
}

export const DEFAULT_DEMO_TIMING: DemoTiming = {
  claimDelayMs: 4_000,
  stepMs: 2_000,
  approachSteps: 12,
  waitAtPickupMs: 8_000,
  tripSteps: 15,
  requestEveryMs: 60_000,
  requestExpireMs: 80_000,
  tickMs: 10_000,
};

let timing = DEFAULT_DEMO_TIMING;

/** Tests only: faster simulations (null: the defaults). */
export function setDemoTimingForTests(next: DemoTiming | null): void {
  timing = next ?? DEFAULT_DEMO_TIMING;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rides with a simulated driver at work right now (one run per ride). */
const running = new Map<string, Promise<void>>();

/** Tests only: wait for a ride's simulated driver to finish. */
export function demoRunFor(rideId: string): Promise<void> | undefined {
  return running.get(rideId);
}

type RideWithPassengers = Ride & { passengers: RidePassenger[] };

async function loadRide(prisma: PrismaClient, rideId: string): Promise<RideWithPassengers | null> {
  return prisma.ride.findUnique({
    where: { id: rideId },
    include: { passengers: { orderBy: { createdAt: "asc" } } },
  });
}

const activeSeat = (ride: RideWithPassengers) =>
  ride.passengers.find(
    (p) => p.status === "WAITING" || p.status === "ARRIVED" || p.status === "PICKED_UP",
  ) ?? null;

async function endsOf(
  prisma: PrismaClient,
  ride: RideWithPassengers,
  seat: RidePassenger,
): Promise<{ pickup: PathPoint; dropoff: PathPoint }> {
  const zones = await getZoneMap(prisma);
  const zonePoint = (id: string): PathPoint => {
    const zone = zones.get(id);
    return { latitude: zone?.latitude ?? 0, longitude: zone?.longitude ?? 0 };
  };
  const pickup =
    seat.pickupLat != null && seat.pickupLng != null
      ? { latitude: seat.pickupLat, longitude: seat.pickupLng }
      : zonePoint(seat.pickupZoneId);
  const dropoff =
    seat.dropoffLat != null && seat.dropoffLng != null
      ? { latitude: seat.dropoffLat, longitude: seat.dropoffLng }
      : zonePoint(seat.dropoffZoneId);
  return { pickup, dropoff };
}

/** Where the simulated driver starts: the campus zone closest to 1 km from the pickup. */
async function startNear(prisma: PrismaClient, pickup: PathPoint): Promise<PathPoint> {
  let best: PathPoint = { latitude: pickup.latitude + 0.008, longitude: pickup.longitude };
  let bestGap = Infinity;
  for (const zone of (await getZoneMap(prisma)).values()) {
    if (zone.retiredAt) continue;
    const gap = Math.abs(haversineDistanceMeters(pickup, zone) - 1_000);
    if (gap < bestGap) {
      bestGap = gap;
      best = { latitude: zone.latitude, longitude: zone.longitude };
    }
  }
  return best;
}

/** Drives along the road route from `from` to `to`, telling the rider where the car is. False if the ride ended on the way. */
async function drive(
  prisma: PrismaClient,
  rideId: string,
  driverId: string,
  from: PathPoint,
  to: PathPoint,
  steps: number,
): Promise<boolean> {
  const route = estimateRoute([from, to]);
  const path = route ? decodePolyline(route.polyline) : [];
  const line = path.length >= 2 ? path : [from, to];
  const length = pathLengthMeters(line);
  for (let i = 1; i <= steps; i += 1) {
    await sleep(timing.stepMs);
    if (!(await stillActive(prisma, rideId))) return false;
    const at = pointAlongPath(line, (length * i) / steps) ?? to;
    emitRideEvent(rideId, RIDE_EVENTS.DRIVER_LOCATION, {
      rideId,
      lat: at.latitude,
      lng: at.longitude,
      ts: Date.now(),
    });
    checkDriverArriving(prisma, rideId, driverId, at);
  }
  return true;
}

async function stillActive(prisma: PrismaClient, rideId: string): Promise<boolean> {
  if (!reviewDemoConfig().enabled) return false;
  const ride = await prisma.ride.findUnique({ where: { id: rideId }, select: { status: true } });
  return Boolean(ride && (ACTIVE_RIDE_STATUSES as readonly string[]).includes(ride.status));
}

async function step(
  prisma: PrismaClient,
  ride: RideWithPassengers,
  seat: RidePassenger,
  driverId: string,
  to: "ARRIVED" | "PICKED_UP" | "DROPPED_OFF",
): Promise<RideWithPassengers> {
  const result = await applyPassengerTransition(prisma, seat.id, to, new Date(), {
    expectedRideId: ride.id,
    expectedDriverId: driverId,
  });
  if (result.changed) {
    await announcePassengerChange(prisma, {
      passenger: result.passenger,
      ride: result.ride,
      rideStatusBefore: result.rideStatusBefore,
      driverUserId: driverId,
    });
  }
  return result.ride;
}

/** The simulated driver serving one demo rider's ride, from wherever it stands. */
async function serveRide(prisma: PrismaClient, rideId: string): Promise<void> {
  const driverId = await ensureDemoAccount(prisma, "simDriver");
  if (!driverId) return;
  let ride = await loadRide(prisma, rideId);
  if (!ride?.isReviewDemo) return;

  if (ride.status === "REQUESTED") {
    await sleep(timing.claimDelayMs);
    if (!reviewDemoConfig().enabled) return;
    const claimed = await claimIfOpen(prisma, rideId, driverId);
    if (!claimed) return; // cancelled meanwhile
    await announceClaim(prisma, claimed, driverId);
    ride = await loadRide(prisma, rideId);
  }
  if (!ride || ride.driverId !== driverId) return;
  const seat = activeSeat(ride);
  if (!seat) return;
  const { pickup, dropoff } = await endsOf(prisma, ride, seat);

  if (seat.status === "WAITING") {
    if (
      !(await drive(
        prisma,
        rideId,
        driverId,
        await startNear(prisma, pickup),
        pickup,
        timing.approachSteps,
      ))
    )
      return;
    ride = await step(prisma, ride, seat, driverId, "ARRIVED");
  }
  if ((activeSeat(ride)?.status ?? seat.status) === "ARRIVED") {
    await sleep(timing.waitAtPickupMs);
    if (!(await stillActive(prisma, rideId))) return;
    ride = await step(prisma, ride, seat, driverId, "PICKED_UP");
  }
  if (activeSeat(ride)?.status === "PICKED_UP") {
    if (!(await drive(prisma, rideId, driverId, pickup, dropoff, timing.tripSteps))) return;
    await step(prisma, ride, seat, driverId, "DROPPED_OFF");
  }
}

/**
 * Starts (or keeps) the simulated driver for a demo rider's ride. Called by
 * broadcastRide instead of offering the ride to anyone. No-op when the demo
 * is off or a run for this ride is already going.
 */
export function dispatchDemoRide(prisma: PrismaClient, rideId: string): void {
  if (!reviewDemoConfig().enabled || running.has(rideId)) return;
  const run = serveRide(prisma, rideId)
    .catch((err) => logger.warn("Review demo: simulated driver stopped", { rideId, err }))
    .finally(() => running.delete(rideId));
  running.set(rideId, run);
}

/** True for a demo ride the simulated driver serves (the demo rider's), false for the simulated rider's own requests. */
export async function isServedBySimDriver(
  prisma: PrismaClient,
  ride: { riderId: string; isReviewDemo: boolean },
): Promise<boolean> {
  if (!ride.isReviewDemo) return false;
  const rider = await prisma.user.findUnique({
    where: { id: ride.riderId },
    select: { phone: true },
  });
  return rider?.phone !== SIM_RIDER_PHONE;
}

// ─── Requests for the demo driver ─────────────────────────────────────────

let lastRequestAt = 0;

/** One look: a new simulated request if the demo driver is online and free, an old unanswered one withdrawn. */
export async function demoRequestTick(
  prisma: PrismaClient,
  now: number = Date.now(),
): Promise<void> {
  const cfg = reviewDemoConfig();
  if (!cfg.enabled || !cfg.driverPhone) return;
  const driver = await prisma.user.findUnique({
    where: { phone: cfg.driverPhone },
    select: {
      id: true,
      isReviewDemo: true,
      driver: { select: { isOnline: true, currentZoneId: true } },
    },
  });
  if (!driver?.isReviewDemo || !driver.driver?.isOnline) return;
  const busy = await prisma.ride.findFirst({
    where: { driverId: driver.id, status: { in: ["MATCHED", "ARRIVED", "IN_PROGRESS"] } },
  });
  if (busy) return;

  const riderId = await ensureDemoAccount(prisma, "simRider");
  if (!riderId) return;
  const open = await prisma.ride.findFirst({
    where: { riderId, status: { in: [...ACTIVE_RIDE_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  if (open) {
    if (
      (open.status === "REQUESTED" || open.status === "AWAITING_RIDER_DECISION") &&
      now - open.createdAt.getTime() >= timing.requestExpireMs
    ) {
      // Unanswered: withdrawn, and a fresh one follows.
      await applyRideTransition(prisma, open.id, "CANCELLED", {
        cancelReason: "RIDER_CANCELLED",
        riderCancel: { reason: null, note: null },
      });
      closeOffer(prisma, open, "CANCELLED");
    }
    return;
  }
  if (now - lastRequestAt < timing.requestEveryMs) return;

  const zones = [...(await getZoneMap(prisma)).values()].filter((zone) => !zone.retiredAt);
  if (zones.length < 2) return;
  const pickup =
    zones.find((zone) => zone.id === driver.driver?.currentZoneId) ??
    zones[Math.floor(Math.random() * zones.length)]!;
  const others = zones.filter((zone) => zone.id !== pickup.id);
  const dropoff = others[Math.floor(Math.random() * others.length)]!;
  lastRequestAt = now;
  // createRide offers it, to online demo drivers only (getEligibleDrivers).
  await createRide(prisma, {
    riderId,
    type: "LONE",
    pickupZoneId: pickup.id,
    dropoffZoneId: dropoff.id,
    paymentMethod: "CASH",
  });
}

/** Tests only. */
export function resetDemoRequestClock(): void {
  lastRequestAt = 0;
}

/**
 * At startup: picks up demo rides a restart interrupted, and starts the
 * request loop for the demo driver. Returns the loop's timer (for shutdown),
 * or null when the demo is off.
 */
export async function startReviewDemo(
  prisma: PrismaClient,
): Promise<ReturnType<typeof setInterval> | null> {
  if (!reviewDemoConfig().enabled) return null;
  await Promise.all(
    (["rider", "driver", "simDriver", "simRider"] as const).map((account) =>
      ensureDemoAccount(prisma, account),
    ),
  );
  const interrupted = await prisma.ride.findMany({
    where: {
      isReviewDemo: true,
      status: { in: ["REQUESTED", "MATCHED", "ARRIVED", "IN_PROGRESS"] },
    },
    select: { id: true, riderId: true, isReviewDemo: true },
  });
  for (const ride of interrupted)
    if (await isServedBySimDriver(prisma, ride)) dispatchDemoRide(prisma, ride.id);
  return setInterval(() => {
    demoRequestTick(prisma).catch((err) =>
      logger.warn("Review demo: request loop failed", { err }),
    );
  }, timing.tickMs);
}
