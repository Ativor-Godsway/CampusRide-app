import type { PrismaClient } from "@prisma/client";
import { getRidePaymentSummary } from "../services/payment/paymentFlow";
import { applyRideTransition } from "../services/ride/rideService";
import { departRide } from "../services/ride/assembly";
import { claimRide } from "../services/ride/dispatch";
import { RideAlreadyClaimedError } from "../services/ride/errors";
import { InvalidTransitionError } from "../services/ride/errors";
import { emitRideEvent } from "../realtime/rideSocket";

const MOCK_DRIVER_PHONE = "+233000000001";

const ASSIGN_DELAY_MS = 4_000;
const ARRIVED_WAIT_MS = 3_000;
const LOCATION_STEPS = 6;
const LOCATION_STEP_INTERVAL_MS = 2_000;

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

  let ride;
  try {
    ride = await claimRide(prisma, rideId, driver.id);
  } catch (err) {
    if (err instanceof RideAlreadyClaimedError) return;
    throw err;
  }

  const withZones = await prisma.ride.findUniqueOrThrow({
    where: { id: rideId },
    include: { pickupZone: true, dropoffZone: true },
  });

  const { _avg } = await prisma.rating.aggregate({
    where: { rateeId: driver.id },
    _avg: { stars: true },
  });

  emitRideEvent(rideId, "ride:status", { rideId, status: ride.status });
  emitRideEvent(rideId, "ride:driver_assigned", {
    rideId,
    driverId: driver.id,
    name: driver.name,
    carMake: driver.driver?.carMake ?? null,
    carModel: driver.driver?.carModel ?? null,
    carColor: driver.driver?.carColor ?? null,
    plate: driver.driver?.plate ?? null,
    rating: _avg.stars ?? null,
  });

  const pickup = { latitude: withZones.pickupZone.latitude, longitude: withZones.pickupZone.longitude };
  const dropoff = { latitude: withZones.dropoffZone.latitude, longitude: withZones.dropoffZone.longitude };
  const start = {
    latitude: pickup.latitude + START_OFFSET.latitude,
    longitude: pickup.longitude + START_OFFSET.longitude,
  };

  await animateLocation(rideId, start, pickup);

  try {
    const arrived = await applyRideTransition(prisma, rideId, "ARRIVED");
    emitRideEvent(rideId, "ride:status", { rideId, status: arrived.status });
  } catch (err) {
    if (err instanceof InvalidTransitionError) return;
    throw err;
  }

  await delay(ARRIVED_WAIT_MS);

  const inProgress = await departRide(prisma, driver.id, rideId);
  emitRideEvent(rideId, "ride:status", { rideId, status: inProgress.status });

  await animateLocation(rideId, pickup, dropoff);

  const completed = await applyRideTransition(prisma, rideId, "COMPLETED");
  emitRideEvent(rideId, "ride:status", { rideId, status: completed.status });

  const summary = await getRidePaymentSummary(prisma, rideId);
  const yourShare = summary.perPassenger.find((p) => p.riderId === withZones.riderId);
  emitRideEvent(rideId, "ride:completed", {
    rideId,
    fareSummary: {
      yourFarePesewas: yourShare?.farePesewas ?? 0,
      totalFarePesewas: summary.totalExpectedPesewas,
    },
  });
}
