import type { RideStatus } from "@rida/shared";
import type { PrismaClient } from "@prisma/client";
import { getRidePaymentSummary } from "../services/payment/paymentFlow";
import { applyPassengerTransition, applyRideTransition } from "../services/ride/rideService";
import { departRide } from "../services/ride/assembly";
import { claimRide } from "../services/ride/dispatch";
import { ACTIVE_DRIVER_STATUSES } from "../services/ride/stateMachine";
import {
  DriverHasActiveRideError,
  InvalidTransitionError,
  RideAlreadyClaimedError,
} from "../services/ride/errors";
import { emitRideEvent, emitToRider } from "../realtime/rideSocket";

const MOCK_DRIVER_PHONE = "+233000000001";

const ASSIGN_DELAY_MS = 4_000;
const ARRIVED_WAIT_MS = 3_000;
const LOCATION_STEPS = 6;
const LOCATION_STEP_INTERVAL_MS = 2_000;
/** How often a queued ride retries while the mock driver is busy with another. */
const BUSY_RETRY_MS = 3_000;

/** Rides this server process is driving right now. */
const inFlight = new Set<string>();

/**
 * Roughly 300m north-west of the pickup zone — gives the driver dot a
 * visible starting point distinct from the pickup marker. Pure offset, no
 * real geocoding needed for a dev simulator.
 */
const START_OFFSET = { latitude: 0.003, longitude: -0.003 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LatLng {
  latitude: number;
  longitude: number;
}

function interpolate(from: LatLng, to: LatLng, fraction: number): LatLng {
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * fraction,
    longitude: from.longitude + (to.longitude - from.longitude) * fraction,
  };
}

/**
 * Finds or creates the single dev mock-driver User+Driver row, shared across
 * all mock-driven rides. Approved and online so it conforms to the same
 * "eligible driver" shape Phase 6's real drivers will have.
 */
async function getOrCreateMockDriver(prisma: PrismaClient) {
  const existing = await prisma.user.findUnique({
    where: { phone: MOCK_DRIVER_PHONE },
    include: { driver: true },
  });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      phone: MOCK_DRIVER_PHONE,
      name: "Kwame Mensah",
      role: "DRIVER",
      driver: {
        create: {
          carMake: "Toyota",
          carModel: "Corolla",
          carColor: "Silver",
          plate: "GR 1234-24",
          isApproved: true,
          isOnline: true,
        },
      },
    },
    include: { driver: true },
  });
}

/**
 * Emits a sequence of `ride:driver_location` pings interpolating from `from`
 * to `to` over `LOCATION_STEPS` steps, one every `LOCATION_STEP_INTERVAL_MS`.
 */
async function animateLocation(rideId: string, from: LatLng, to: LatLng): Promise<void> {
  for (let step = 1; step <= LOCATION_STEPS; step++) {
    await delay(LOCATION_STEP_INTERVAL_MS);
    const point = interpolate(from, to, step / LOCATION_STEPS);
    emitRideEvent(rideId, "ride:driver_location", {
      rideId,
      lat: point.latitude,
      lng: point.longitude,
      ts: Date.now(),
    });
  }
}

/**
 * Dev-only ride simulator (Phase 5c). Drives a freshly REQUESTED ride
 * through the real state machine — claimRide, ARRIVED, departRide,
 * COMPLETED — using a single shared mock driver, emitting the same
 * Socket.io contract events (`@rida/shared`'s RIDE_EVENTS) that Phase 6's
 * real driver app will emit. Gated behind config.enableMockDriver; never
 * call this in production.
 *
 * Fire-and-forget: errors (e.g. the ride was cancelled before the mock
 * driver claimed it) are logged, not thrown, since this runs detached from
 * the request that created the ride.
 */
export function startMockDriverForRide(prisma: PrismaClient, rideId: string): void {
  simulate(prisma, rideId).catch((err) => {
    console.error(`[mockDriver] simulation failed for ride ${rideId}:`, err);
  });
}

async function simulate(prisma: PrismaClient, rideId: string): Promise<void> {
  await delay(ASSIGN_DELAY_MS);

  const driver = await getOrCreateMockDriver(prisma);

  // One mock driver serves every ride, one at a time: while it is busy, a
  // new request waits its turn (it stays REQUESTED, exactly as it would for a
  // real busy driver) instead of failing.
  let ride;
  for (;;) {
    try {
      await finishOrphanedRides(prisma, driver.id);
      ride = await claimRide(prisma, rideId, driver.id);
      break;
    } catch (err) {
      if (err instanceof RideAlreadyClaimedError) return;
      if (!(err instanceof DriverHasActiveRideError)) throw err;
      const current = await prisma.ride.findUnique({ where: { id: rideId }, select: { status: true } });
      if (current?.status !== "REQUESTED") return;
      await delay(BUSY_RETRY_MS);
    }
  }

  inFlight.add(rideId);
  try {
    await driveClaimedRide(prisma, driver, ride.id, ride.status);
  } finally {
    inFlight.delete(rideId);
  }
}

/**
 * A ride the mock driver still holds but no simulation in THIS process is
 * driving was left behind by an earlier server process — `npm run dev:server`
 * restarts on every file save. Left alone it would keep the mock driver
 * "busy" forever (so every later request goes unanswered) and keep its rider
 * stuck on an active ride they can never leave. Finish it straight away.
 */
async function finishOrphanedRides(prisma: PrismaClient, driverId: string): Promise<void> {
  const orphans = await prisma.ride.findMany({
    where: {
      driverId,
      status: { in: [...ACTIVE_DRIVER_STATUSES] },
      id: { notIn: [...inFlight] },
    },
    select: { id: true },
  });
  for (const orphan of orphans) {
    console.warn(`[mockDriver] finishing ride ${orphan.id}, left over from an earlier server run`);
    await walkToCompletion(prisma, driverId, orphan.id);
    emitRideEvent(orphan.id, "ride:status", { rideId: orphan.id, status: "COMPLETED" });
  }
}

async function driveClaimedRide(
  prisma: PrismaClient,
  driver: Awaited<ReturnType<typeof getOrCreateMockDriver>>,
  rideId: string,
  status: RideStatus,
): Promise<void> {
  const withZones = await prisma.ride.findUniqueOrThrow({
    where: { id: rideId },
    include: { pickupZone: true, dropoffZone: true },
  });

  const { _avg } = await prisma.rating.aggregate({
    where: { rateeId: driver.id },
    _avg: { stars: true },
  });

  emitRideEvent(rideId, "ride:status", { rideId, status });
  emitRideEvent(rideId, "ride:driver_assigned", {
    rideId,
    driverId: driver.id,
    name: driver.name,
    carMake: driver.driver?.carMake ?? null,
    carModel: driver.driver?.carModel ?? null,
    carColor: driver.driver?.carColor ?? null,
    plate: driver.driver?.plate ?? null,
    rating: _avg.stars ?? null,
    // Real, reachable Cloudinary URL (public demo cloud, has a face) so dev
    // mode actually renders a photo and exercises the g_face/c_fill transform.
    photoUrl: "https://res.cloudinary.com/demo/image/upload/woman.jpg",
  });

  const pickup = { latitude: withZones.pickupZone.latitude, longitude: withZones.pickupZone.longitude };
  const dropoff = { latitude: withZones.dropoffZone.latitude, longitude: withZones.dropoffZone.longitude };
  const start = {
    latitude: pickup.latitude + START_OFFSET.latitude,
    longitude: pickup.longitude + START_OFFSET.longitude,
  };

  await animateLocation(rideId, start, pickup);

  try {
    if (withZones.type === "SHARED") {
      // Shared rides move each passenger, as the real driver app does:
      // the rider app reads its own seat ("Kwame has arrived", "On your
      // trip") and would otherwise sit on "on the way" for the whole trip.
      await passengerStep(prisma, rideId, "ARRIVED");
    } else {
      const arrived = await applyRideTransition(prisma, rideId, "ARRIVED");
      emitRideEvent(rideId, "ride:status", { rideId, status: arrived.status });
    }
  } catch (err) {
    if (err instanceof InvalidTransitionError) return; // cancelled meanwhile
    throw err;
  }

  await delay(ARRIVED_WAIT_MS);

  if (withZones.type === "SHARED") {
    await passengerStep(prisma, rideId, "PICKED_UP");
    emitRideEvent(rideId, "ride:status", { rideId, status: "IN_PROGRESS" });
  } else {
    const inProgress = await departRide(prisma, driver.id, rideId);
    emitRideEvent(rideId, "ride:status", { rideId, status: inProgress.status });
  }

  await animateLocation(rideId, pickup, dropoff);

  if (withZones.type === "SHARED") {
    await passengerStep(prisma, rideId, "DROPPED_OFF"); // last drop-off completes the ride
  } else {
    await applyRideTransition(prisma, rideId, "COMPLETED");
  }
  emitRideEvent(rideId, "ride:status", { rideId, status: "COMPLETED" });

  const summary = await getRidePaymentSummary(prisma, rideId);
  const yourShare = summary.perPassenger.find((p) => p.riderId === withZones.riderId);
  emitRideEvent(rideId, "ride:completed", {
    rideId,
    fareSummary: {
      yourFarePesewas: yourShare?.farePesewas ?? 0,
      totalFarePesewas: summary.totalExpectedPesewas,
      paymentMethod: (withZones.paymentMethod ?? "MOMO") as "CASH" | "MOMO",
      paymentStatus: yourShare?.status ?? "PENDING",
    },
  });
}

/** Moves every passenger still in the car one step (WAITING → ARRIVED → PICKED_UP → DROPPED_OFF). */
async function passengerStep(
  prisma: PrismaClient,
  rideId: string,
  to: "ARRIVED" | "PICKED_UP" | "DROPPED_OFF",
): Promise<void> {
  const from = { ARRIVED: "WAITING", PICKED_UP: "ARRIVED", DROPPED_OFF: "PICKED_UP" } as const;
  const passengers = await prisma.ridePassenger.findMany({
    where: { rideId, status: from[to] },
    orderBy: { createdAt: "asc" },
  });
  for (const p of passengers) {
    await applyPassengerTransition(prisma, p.id, to);
    emitToRider(p.riderId, "ride:passenger_status", {
      rideId,
      ridePassengerId: p.id,
      riderId: p.riderId,
      status: to,
    });
  }
}

/** Finishes a held ride immediately, from whatever stage it reached. */
async function walkToCompletion(prisma: PrismaClient, driverId: string, rideId: string): Promise<void> {
  const ride = await prisma.ride.findUniqueOrThrow({ where: { id: rideId } });
  if (ride.type === "SHARED") {
    for (const step of ["ARRIVED", "PICKED_UP", "DROPPED_OFF"] as const) {
      await passengerStep(prisma, rideId, step);
    }
    return;
  }
  if (ride.status === "MATCHED") await applyRideTransition(prisma, rideId, "ARRIVED");
  if (ride.status === "MATCHED" || ride.status === "ARRIVED") await departRide(prisma, driverId, rideId);
  await applyRideTransition(prisma, rideId, "COMPLETED");
}
