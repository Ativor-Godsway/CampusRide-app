import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { PaymentMethod } from "@rida/shared";
import { getLoneFare, getSharedFarePerRider, splitFare, designateBestFit } from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { claimRide } from "../services/ride/dispatch";
import { departRide } from "../services/ride/assembly";
import { applyRideTransition } from "../services/ride/rideService";
import { RideAlreadyClaimedError, InvalidTransitionError } from "../services/ride/errors";
import { emitRideEvent } from "../realtime/rideSocket";
import { getRidePaymentSummary } from "../services/payment/paymentFlow";

/** Returns the set of zone IDs a driver in `zoneId` is eligible to serve (same zone + 1 hop). */
function computeEligibleZoneSet(
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

const ACTIVE_DRIVER_STATUSES = ["MATCHED", "ARRIVED", "IN_PROGRESS"] as const;

async function requireDriver(request: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]): Promise<boolean> {
  if (request.user?.role !== "DRIVER") {
    reply.code(403).send({ error: "Driver role required" });
    return false;
  }
  return true;
}

async function getDriverInfo(prisma: PrismaClient, driverId: string) {
  const [driver, { _avg }] = await Promise.all([
    prisma.user.findUnique({ where: { id: driverId }, include: { driver: true } }),
    prisma.rating.aggregate({ where: { rateeId: driverId }, _avg: { stars: true } }),
  ]);
  if (!driver) return null;
  return {
    driverId: driver.id,
    name: driver.name,
    carMake: driver.driver?.carMake ?? null,
    carModel: driver.driver?.carModel ?? null,
    carColor: driver.driver?.carColor ?? null,
    plate: driver.driver?.plate ?? null,
    rating: _avg.stars ?? null,
  };
}

export function registerDriverRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  /**
   * Set the driver's online/offline status and current zone.
   * Going online makes the driver eligible for ride broadcasts.
   */
  app.patch("/driver/availability", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const body = request.body as { isOnline?: unknown; zoneId?: unknown };
    if (typeof body.isOnline !== "boolean") {
      return reply.code(400).send({ error: "isOnline (boolean) is required" });
    }

    const userId = request.user!.userId;

    const driver = await prisma.driver.findUnique({ where: { userId } });
    if (!driver) {
      return reply.code(404).send({ error: "Driver profile not found" });
    }
    if (body.isOnline && (!driver.carMake || !driver.carModel || !driver.carColor || !driver.plate)) {
      return reply.code(403).send({ error: "Complete your driver profile before going online" });
    }

    if (!driver.isApproved) {
      return reply.code(403).send({ error: "Driver account is not approved yet" });
    }

    const zoneId = typeof body.zoneId === "string" && body.zoneId.length > 0
      ? body.zoneId
      : undefined;

    if (zoneId) {
      const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
      if (!zone) return reply.code(404).send({ error: "Zone not found" });
    }

    const updated = await prisma.driver.update({
      where: { userId },
      data: {
        isOnline: body.isOnline,
        ...(zoneId !== undefined ? { currentZoneId: zoneId } : {}),
        ...(!body.isOnline ? { currentZoneId: null } : {}),
      },
    });

    return reply.code(200).send({ driver: updated });
  });

  /** The driver's currently active ride (MATCHED, ARRIVED, or IN_PROGRESS), if any. */
  app.get("/driver/rides/active", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const userId = request.user!.userId;

    const ride = await prisma.ride.findFirst({
      where: {
        driverId: userId,
        status: { in: [...ACTIVE_DRIVER_STATUSES] },
      },
      include: { pickupZone: true, dropoffZone: true, passengers: true },
      orderBy: { createdAt: "desc" },
    });

    return reply.code(200).send({ ride: ride ?? null });
  });

  /**
   * Atomically claim a REQUESTED ride (first-to-claim-wins).
   * On success emits ride:status (MATCHED) + ride:driver_assigned to the ride room.
   */
  app.post("/rides/:id/claim", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const driver = await prisma.driver.findUnique({ where: { userId } });
    if (!driver?.isApproved || !driver.isOnline) {
      return reply.code(403).send({ error: "Driver must be online and approved to claim rides" });
    }

    try {
      const ride = await claimRide(prisma, rideId, userId);

      const driverInfo = await getDriverInfo(prisma, userId);

      emitRideEvent(rideId, "ride:status", { rideId, status: ride.status });
      if (driverInfo) {
        emitRideEvent(rideId, "ride:driver_assigned", { rideId, ...driverInfo });
      }

      return reply.code(200).send({ ride });
    } catch (err) {
      if (err instanceof RideAlreadyClaimedError) {
        return reply.code(409).send({ error: "Ride already claimed by another driver" });
      }
      throw err;
    }
  });

  /** Driver has arrived at the pickup zone — transitions MATCHED → ARRIVED. */
  app.post("/rides/:id/arrived", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) return reply.code(404).send({ error: "Ride not found" });
    if (ride.driverId !== userId) return reply.code(403).send({ error: "Forbidden" });

    try {
      const updated = await applyRideTransition(prisma, rideId, "ARRIVED");
      emitRideEvent(rideId, "ride:status", { rideId, status: updated.status });
      return reply.code(200).send({ ride: updated });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.code(409).send({ error: "Invalid transition from current ride status" });
      }
      throw err;
    }
  });

  /**
   * Driver departs with the rider — transitions ARRIVED → IN_PROGRESS.
   * Also initiates payment collection (departRide handles that internally).
   */
  app.post("/rides/:id/depart", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    try {
      const updated = await departRide(prisma, userId, rideId);
      emitRideEvent(rideId, "ride:status", { rideId, status: updated.status });
      return reply.code(200).send({ ride: updated });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.code(409).send({ error: "Invalid transition from current ride status" });
      }
      throw err;
    }
  });

  /**
   * Returns the list of REQUESTED rides this driver is currently eligible to claim.
   * Eligible = ride's pickupZone is in the driver's zone or an adjacent zone, ride is
   * unclaimed, and the broadcast window (90 s) hasn't expired. Each ride includes a
   * `bestFit` flag derived from the existing Phase-2e bestFit scoring logic.
   */
  app.get("/driver/rides/eligible", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const userId = request.user!.userId;

    const driver = await prisma.driver.findUnique({ where: { userId } });
    if (!driver || !driver.isOnline || !driver.isApproved || !driver.currentZoneId) {
      return reply.code(200).send({ rides: [] });
    }

    // Full adjacency graph — small table (~30 edges for 15 zones), fetched once.
    const allAdjacencies = await prisma.zoneAdjacency.findMany();

    // Zones where this driver is eligible to pick up.
    const driverEligibleZones = computeEligibleZoneSet(driver.currentZoneId, allAdjacencies);

    // All unclaimed REQUESTED rides whose pickup is in those zones and are still within
    // the 90-second broadcast window.
    const BROADCAST_WINDOW_MS = 90_000;
    const cutoff = new Date(Date.now() - BROADCAST_WINDOW_MS);

    const rides = await prisma.ride.findMany({
      where: {
        status: "REQUESTED",
        driverId: null,
        pickupZoneId: { in: Array.from(driverEligibleZones) },
        broadcastStartedAt: { gte: cutoff },
      },
      include: { pickupZone: true, dropoffZone: true },
      orderBy: { createdAt: "desc" },
    });

    if (rides.length === 0) {
      return reply.code(200).send({ rides: [] });
    }

    // Compute the union of all zones eligible for any of these rides — lets us fetch
    // all potentially-eligible drivers in a single query.
    const allRideEligibleZones = new Set<string>();
    const rideZoneMap = new Map<string, Set<string>>();

    for (const ride of rides) {
      const zones = computeEligibleZoneSet(ride.pickupZoneId, allAdjacencies);
      rideZoneMap.set(ride.id, zones);
      for (const z of zones) allRideEligibleZones.add(z);
    }

    const allEligibleDrivers = await prisma.driver.findMany({
      where: {
        isOnline: true,
        isApproved: true,
        currentZoneId: { in: Array.from(allRideEligibleZones) },
      },
      select: { userId: true, currentZoneId: true },
    });

    const result = rides.map((ride) => {
      const eligibleZones = rideZoneMap.get(ride.id)!;
      const rideDrivers = allEligibleDrivers.filter(
        (d) => d.currentZoneId !== null && eligibleZones.has(d.currentZoneId),
      );

      const bestFitResults = designateBestFit(
        { pickupZoneId: ride.pickupZoneId, dropoffZoneId: ride.dropoffZoneId },
        rideDrivers.map((d) => ({ driverUserId: d.userId, currentZoneId: d.currentZoneId })),
        allAdjacencies,
      );

      const myResult = bestFitResults.find((r) => r.driverUserId === userId);

      const farePesewas =
        ride.type === "LONE" ? getLoneFare() : getSharedFarePerRider(ride.occupancy);
      const { driverShare } = splitFare(farePesewas);

      return {
        rideId: ride.id,
        pickupZoneName: ride.pickupZone.name,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneName: ride.dropoffZone.name,
        dropoffZoneId: ride.dropoffZoneId,
        type: ride.type as "LONE" | "SHARED",
        farePesewas,
        driverSharePesewas: driverShare,
        createdAt: ride.createdAt.toISOString(),
        bestFit: myResult?.bestFit ?? false,
      };
    });

    return reply.code(200).send({ rides: result });
  });

  /** Driver completes the ride — transitions IN_PROGRESS → COMPLETED and emits fare summary. */
  app.post("/rides/:id/complete", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { passengers: true },
    });
    if (!ride) return reply.code(404).send({ error: "Ride not found" });
    if (ride.driverId !== userId) return reply.code(403).send({ error: "Forbidden" });

    try {
      const updated = await applyRideTransition(prisma, rideId, "COMPLETED");
      emitRideEvent(rideId, "ride:status", { rideId, status: updated.status });

      const summary = await getRidePaymentSummary(prisma, rideId);
      const yourShare = summary.perPassenger.find((p) => p.riderId === ride.riderId);

      const paymentMethod = ride.paymentMethod as PaymentMethod;

      // For CASH rides, record the platform's 15% commission as a debt entry.
      if (paymentMethod === "CASH") {
        const farePesewasForLedger =
          ride.type === "LONE"
            ? getLoneFare()
            : getSharedFarePerRider(ride.occupancy) * ride.occupancy;
        const { commission } = splitFare(farePesewasForLedger);
        await prisma.commissionLedger.upsert({
          where: { rideId },
          update: {},
          create: { driverUserId: userId, rideId, amountPesewas: commission },
        });
      }

      emitRideEvent(rideId, "ride:completed", {
        rideId,
        fareSummary: {
          yourFarePesewas: yourShare?.farePesewas ?? 0,
          totalFarePesewas: summary.totalExpectedPesewas,
          paymentMethod,
          paymentStatus: yourShare?.status ?? "PENDING",
        },
      });

      // Compute driver's earnings from the completed ride
      const farePesewas =
        ride.type === "LONE"
          ? getLoneFare()
          : getSharedFarePerRider(ride.occupancy);
      const totalFare = ride.type === "LONE" ? farePesewas : farePesewas * ride.occupancy;
      const { driverShare } = splitFare(totalFare);

      return reply.code(200).send({ ride: updated, driverSharePesewas: driverShare });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.code(409).send({ error: "Invalid transition from current ride status" });
      }
      throw err;
    }
  });
}
