import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { PaymentMethod, PassengerStatus, RideSource } from "@rida/shared";
import { getLoneFare, getSharedFarePerRider, splitFare, designateBestFit, PRICING } from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { claimRide } from "../services/ride/dispatch";
import { departRide, addRiderToCar } from "../services/ride/assembly";
import type { RideWithPassengers } from "../services/ride/assembly";
import { suggestFillsForRide } from "../services/ride/ranking";
import { applyRideTransition, applyPassengerTransition } from "../services/ride/rideService";
import { isActivePassengerStatus } from "../services/ride/stateMachine";
import {
  RideAlreadyClaimedError,
  InvalidTransitionError,
  NotRideOwnerError,
  RideNotFillableError,
  NoSeatsAvailableError,
  RequestRideUnavailableError,
} from "../services/ride/errors";
import { emitRideEvent, emitToRider } from "../realtime/rideSocket";
import { getRidePaymentSummary } from "../services/payment/paymentFlow";
import { notifyUssdRider, notifyUssdRiders } from "../services/sms/notifyUssdRiders";

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

/**
 * Finalizes a COMPLETED ride's payment side: a CASH CommissionLedger upsert,
 * and a per-rider `ride:completed` fare summary emitted via `emitToRider` to
 * EACH billable passenger individually — not one ride-room broadcast carrying
 * a single fare. Shared by the ride-level `/complete` route (LONE rides) and
 * the per-passenger last-dropoff auto-completion path (SHARED rides, in the
 * new `/passengers/:passengerId/dropoff` route below). Previously `/complete`
 * emitted ONE `ride:completed` event to the whole ride room using only
 * `ride.riderId`'s fare — correct for LONE (single passenger) but wrong for
 * every other SHARED passenger (masked only by the rider app's poll
 * fallback, which computes its own fareSummary per-requester).
 */
async function finalizeRideCompletion(
  prisma: PrismaClient,
  ride: { id: string; type: "LONE" | "SHARED"; occupancy: number; paymentMethod: string; source: RideSource },
  driverUserId: string,
): Promise<void> {
  const paymentMethod = ride.paymentMethod as PaymentMethod;

  if (paymentMethod === "CASH") {
    const farePesewasForLedger =
      ride.type === "LONE"
        ? getLoneFare()
        : getSharedFarePerRider(ride.occupancy) * ride.occupancy;
    const { commission } = splitFare(farePesewasForLedger);
    await prisma.commissionLedger.upsert({
      where: { rideId: ride.id },
      update: {},
      create: { driverUserId, rideId: ride.id, amountPesewas: commission },
    });
  }

  const summary = await getRidePaymentSummary(prisma, ride.id);
  for (const p of summary.perPassenger) {
    emitToRider(p.riderId, "ride:completed", {
      rideId: ride.id,
      fareSummary: {
        yourFarePesewas: p.farePesewas,
        totalFarePesewas: summary.totalExpectedPesewas,
        paymentMethod,
        paymentStatus: p.status,
      },
    });
  }

  // USSD-origin riders have no app to receive ride:completed on, so they get
  // an SMS instead — covers both this ride-level /complete (LONE) and the
  // per-passenger last-dropoff auto-completion (SHARED), since both call
  // this function. Fire-and-forget, never throws into the transition path.
  if (ride.source === "USSD") {
    void notifyUssdRiders(
      prisma,
      summary.perPassenger.map((p) => p.riderId),
      "Trip complete. Thanks for riding CampusRide.",
    );
  }
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
      include: {
        pickupZone: true,
        dropoffZone: true,
        // Zone names nested per-passenger (Phase 6b-3) — the driving view of a
        // SHARED ride (IN_PROGRESS) needs each passenger's own pickup/dropoff
        // for the per-passenger pickup/dropoff list, same shape as
        // fill-suggestions' PassengerInCar.
        passengers: { include: { pickupZone: true, dropoffZone: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!ride) return reply.code(200).send({ ride: null });

    const { passengers, ...rideFields } = ride;
    return reply.code(200).send({
      ride: {
        ...rideFields,
        passengers: passengers.map((p) => ({
          id: p.id,
          riderId: p.riderId,
          pickupZoneName: p.pickupZone.name,
          dropoffZoneName: p.dropoffZone.name,
          lockedFare: p.lockedFare,
          status: p.status,
        })),
      },
    });
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

      if (ride.source === "USSD") {
        void notifyUssdRider(prisma, ride.riderId, "Driver matched! They're on the way.");
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
      if (updated.source === "USSD") {
        void notifyUssdRider(prisma, updated.riderId, "Your driver has arrived.");
      }
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
   * LONE rides only: a SHARED ride now departs automatically on its first
   * passenger pickup (see /rides/:id/passengers/:passengerId/pickup below) —
   * calling this on a SHARED ride would skip the per-passenger flow entirely
   * and leave passengers stuck at WAITING/ARRIVED while the ride itself
   * reports IN_PROGRESS, so it's rejected here.
   */
  app.post("/rides/:id/depart", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const existingRide = await prisma.ride.findUnique({ where: { id: rideId } });
    if (existingRide?.type === "SHARED") {
      return reply
        .code(409)
        .send({ error: "SHARED rides depart automatically on the first passenger pickup" });
    }

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

  /**
   * Returns ALL pending, addable SHARED requests for the driver's claimed
   * anchor ride (MATCHED or ARRIVED) — compatible ones (per the existing
   * Phase-2c `suggestFillsForRide` ranking) first, flagged `compatible: true`
   * (badge-eligible), every other still-pending SHARED request after,
   * flagged `compatible: false`, ordered by createdAt desc. Compatibility is
   * a SORT HINT only, not a filter — the driver may add any of them.
   *
   * Hard addable boundary (the only real filter): status REQUESTED, unclaimed,
   * SHARED, anchor has a free seat (occupancy < 4), anchor still assembling
   * (MATCHED/ARRIVED, checked above). No fare-impact preview — shared fare
   * is flat per rider, unaffected by who's added.
   */
  app.get("/rides/:id/fill-suggestions", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    // Load anchor with passengers (including zone names) for response + suggestFillsForRide
    const anchor = await prisma.ride.findUnique({
      where: { id: rideId },
      include: {
        passengers: { include: { pickupZone: true, dropoffZone: true } },
        pickupZone: true,
        dropoffZone: true,
      },
    });
    if (!anchor) return reply.code(404).send({ error: "Ride not found" });
    if (anchor.driverId !== userId) return reply.code(403).send({ error: "Forbidden" });
    if (anchor.type !== "SHARED") return reply.code(400).send({ error: "Ride is not SHARED" });
    if (anchor.status !== "MATCHED" && anchor.status !== "ARRIVED") {
      return reply.code(400).send({ error: "Ride is not in an assembly state" });
    }

    const [adjacency, allCandidates] = await Promise.all([
      prisma.zoneAdjacency.findMany(),
      prisma.ride.findMany({
        where: { status: "REQUESTED", driverId: null, type: "SHARED" },
        include: { pickupZone: true, dropoffZone: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // suggestFillsForRide needs RideWithPassengers (plain passengers include, no zone nesting).
    // anchor satisfies this structurally — cast is safe. Its own internal
    // areCombinable filter is exactly what makes this the "compatible,
    // ranked" subset — left untouched, its contract/tests stay as-is.
    const compatibleRanked = suggestFillsForRide(
      anchor as unknown as RideWithPassengers,
      allCandidates,
      adjacency,
      new Date(),
    );
    const compatibleIds = new Set(compatibleRanked.map((r) => r.id));
    const zoneMap = new Map(allCandidates.map((r) => [r.id, r]));
    const existingRiderIds = new Set(anchor.passengers.map((p) => p.riderId));
    const isFull = anchor.occupancy >= PRICING.MAX_SHARED_OCCUPANCY;

    const toSuggestion = (r: (typeof allCandidates)[number], compatible: boolean) => ({
      requestRideId: r.id,
      pickupZoneName: r.pickupZone.name,
      pickupZoneId: r.pickupZoneId,
      dropoffZoneName: r.dropoffZone.name,
      dropoffZoneId: r.dropoffZoneId,
      createdAt: r.createdAt.toISOString(),
      compatible,
    });

    const compatibleSuggestions = isFull
      ? []
      : compatibleRanked
          .map((r) => zoneMap.get(r.id))
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
          .map((r) => toSuggestion(r, true));

    const restSuggestions = isFull
      ? []
      : allCandidates
          .filter((r) => !compatibleIds.has(r.id) && !existingRiderIds.has(r.riderId))
          .map((r) => toSuggestion(r, false));

    const suggestions = [...compatibleSuggestions, ...restSuggestions];

    // isActivePassengerStatus (WAITING/ARRIVED/PICKED_UP) — NOT a hardcoded
    // WAITING||PICKED_UP list, which would silently drop a passenger the
    // moment the driver marks them ARRIVED ("I'm here"), making their row
    // vanish from this list on the very next poll.
    const currentPassengers = anchor.passengers
      .filter((p) => isActivePassengerStatus(p.status))
      .map((p) => ({
        id: p.id,
        riderId: p.riderId,
        pickupZoneName: p.pickupZone.name,
        dropoffZoneName: p.dropoffZone.name,
        lockedFare: p.lockedFare,
        status: p.status,
      }));

    return reply.code(200).send({
      occupancy: anchor.occupancy,
      passengers: currentPassengers,
      suggestions,
    });
  });

  /**
   * Driver adds a compatible SHARED request to their claimed car.
   * Wraps the existing atomic `addRiderToCar` — no new business logic.
   * On success returns the updated passenger list with current locked fares.
   */
  app.post("/rides/:id/add-passenger", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;
    const body = request.body as { requestRideId?: unknown };

    if (typeof body.requestRideId !== "string" || body.requestRideId.length === 0) {
      return reply.code(400).send({ error: "requestRideId (string) is required" });
    }

    try {
      const updatedAnchor = await addRiderToCar(prisma, userId, rideId, body.requestRideId);

      // Reload with zone names for the response.
      const withZones = await prisma.ride.findUniqueOrThrow({
        where: { id: rideId },
        include: { passengers: { include: { pickupZone: true, dropoffZone: true } } },
      });

      const passengers = withZones.passengers
        .filter((p) => isActivePassengerStatus(p.status))
        .map((p) => ({
          id: p.id,
          riderId: p.riderId,
          pickupZoneName: p.pickupZone.name,
          dropoffZoneName: p.dropoffZone.name,
          lockedFare: p.lockedFare,
          status: p.status,
        }));

      return reply.code(200).send({ occupancy: updatedAnchor.occupancy, passengers });
    } catch (err) {
      if (err instanceof NotRideOwnerError) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (
        err instanceof RideNotFillableError ||
        err instanceof NoSeatsAvailableError ||
        err instanceof RequestRideUnavailableError
      ) {
        return reply.code(409).send({ error: (err as Error).message });
      }
      throw err;
    }
  });

  /**
   * Driver completes the ride — transitions IN_PROGRESS → COMPLETED and emits fare summary.
   * LONE rides only: a SHARED ride now completes automatically when its last
   * active passenger is dropped off (see /rides/:id/passengers/:passengerId/dropoff
   * below) — calling this directly on a SHARED ride could complete it while
   * passengers are still WAITING/ARRIVED/PICKED_UP, so it's rejected here.
   */
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
    if (ride.type === "SHARED") {
      return reply
        .code(409)
        .send({ error: "SHARED rides complete automatically when the last passenger is dropped off" });
    }

    try {
      const updated = await applyRideTransition(prisma, rideId, "COMPLETED");
      emitRideEvent(rideId, "ride:status", { rideId, status: updated.status });

      await finalizeRideCompletion(prisma, updated, userId);

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

  /**
   * Per-passenger lifecycle (Phase 6b-3): driver has arrived at THIS
   * passenger's pickup point. WAITING -> ARRIVED only — no ride-level effect,
   * no effect on any other passenger on the same car.
   */
  app.post(
    "/rides/:id/passengers/:passengerId/arrived",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await requireDriver(request, reply))) return;

      const { id: rideId, passengerId } = request.params as { id: string; passengerId: string };
      const userId = request.user!.userId;

      const ride = await prisma.ride.findUnique({ where: { id: rideId } });
      if (!ride) return reply.code(404).send({ error: "Ride not found" });
      if (ride.driverId !== userId) return reply.code(403).send({ error: "Forbidden" });

      const passenger = await prisma.ridePassenger.findUnique({ where: { id: passengerId } });
      if (!passenger || passenger.rideId !== rideId) {
        return reply.code(404).send({ error: "Passenger not found on this ride" });
      }

      try {
        const result = await applyPassengerTransition(prisma, passengerId, "ARRIVED");

        emitToRider(passenger.riderId, "ride:passenger_status", {
          rideId,
          ridePassengerId: passengerId,
          riderId: passenger.riderId,
          status: result.passenger.status as PassengerStatus,
        });

        if (ride.source === "USSD") {
          void notifyUssdRider(prisma, passenger.riderId, "Your driver has arrived.");
        }

        return reply.code(200).send({ passenger: result.passenger, ride: result.ride });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: "Invalid transition from current passenger status" });
        }
        throw err;
      }
    },
  );

  /**
   * Per-passenger lifecycle (Phase 6b-3): driver has picked up THIS
   * passenger. ARRIVED -> PICKED_UP. If this is the ride's first pickup, the
   * ride itself is walked forward to IN_PROGRESS as a side effect inside the
   * same transaction (see applyPassengerTransition) — no separate
   * ride-level "depart" call is needed or allowed for SHARED rides anymore.
   */
  app.post(
    "/rides/:id/passengers/:passengerId/pickup",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await requireDriver(request, reply))) return;

      const { id: rideId, passengerId } = request.params as { id: string; passengerId: string };
      const userId = request.user!.userId;

      const ride = await prisma.ride.findUnique({ where: { id: rideId } });
      if (!ride) return reply.code(404).send({ error: "Ride not found" });
      if (ride.driverId !== userId) return reply.code(403).send({ error: "Forbidden" });

      const passenger = await prisma.ridePassenger.findUnique({ where: { id: passengerId } });
      if (!passenger || passenger.rideId !== rideId) {
        return reply.code(404).send({ error: "Passenger not found on this ride" });
      }

      try {
        const result = await applyPassengerTransition(prisma, passengerId, "PICKED_UP");

        emitToRider(passenger.riderId, "ride:passenger_status", {
          rideId,
          ridePassengerId: passengerId,
          riderId: passenger.riderId,
          status: result.passenger.status as PassengerStatus,
        });

        // First pickup may have just walked the ride to IN_PROGRESS — tell
        // everyone in the ride room once (map/location consumers, other
        // passengers' "car is moving" state), ride-wide and exactly once.
        if (result.ride.status === "IN_PROGRESS" && ride.status !== "IN_PROGRESS") {
          emitRideEvent(rideId, "ride:status", { rideId, status: result.ride.status });
        }

        return reply.code(200).send({ passenger: result.passenger, ride: result.ride });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: "Invalid transition from current passenger status" });
        }
        throw err;
      }
    },
  );

  /**
   * Per-passenger lifecycle (Phase 6b-3): driver has dropped off THIS
   * passenger. PICKED_UP -> DROPPED_OFF, stamping fareCharged from their
   * frozen lockedFare. If no passenger remains WAITING/ARRIVED/PICKED_UP, the
   * ride itself completes as a side effect (same transaction) and
   * finalizeRideCompletion runs the same CommissionLedger + per-rider fare
   * summary logic the ride-level /complete route uses for LONE rides.
   */
  app.post(
    "/rides/:id/passengers/:passengerId/dropoff",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await requireDriver(request, reply))) return;

      const { id: rideId, passengerId } = request.params as { id: string; passengerId: string };
      const userId = request.user!.userId;

      const ride = await prisma.ride.findUnique({ where: { id: rideId } });
      if (!ride) return reply.code(404).send({ error: "Ride not found" });
      if (ride.driverId !== userId) return reply.code(403).send({ error: "Forbidden" });

      const passenger = await prisma.ridePassenger.findUnique({ where: { id: passengerId } });
      if (!passenger || passenger.rideId !== rideId) {
        return reply.code(404).send({ error: "Passenger not found on this ride" });
      }

      try {
        const result = await applyPassengerTransition(prisma, passengerId, "DROPPED_OFF");

        emitToRider(passenger.riderId, "ride:passenger_status", {
          rideId,
          ridePassengerId: passengerId,
          riderId: passenger.riderId,
          status: result.passenger.status as PassengerStatus,
        });

        const justCompleted = result.ride.status === "COMPLETED" && ride.status !== "COMPLETED";
        if (justCompleted) {
          emitRideEvent(rideId, "ride:status", { rideId, status: result.ride.status });
          await finalizeRideCompletion(
            prisma,
            {
              id: result.ride.id,
              type: ride.type,
              occupancy: result.ride.occupancy,
              paymentMethod: result.ride.paymentMethod,
              source: ride.source,
            },
            userId,
          );
        }

        return reply.code(200).send({ passenger: result.passenger, ride: result.ride });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: "Invalid transition from current passenger status" });
        }
        throw err;
      }
    },
  );
}
