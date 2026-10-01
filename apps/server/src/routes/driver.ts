import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { PaymentMethod, PassengerStatus, RideSource, RideStatus } from "@rida/shared";
import {
  DISPATCH_WINDOW_MS,
  PRICING,
  designateBestFit,
  encodePolyline,
  getDriverGrossForRide,
  getLoneFare,
  getSharedFarePerRider,
  getSharedTotalFare,
  indexRoutes,
  onboardAddNotice,
  previewAddRider,
  splitFare,
} from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { isValidDriverPhotoUrl } from "../services/uploads/cloudinarySignature";
import { config } from "../config";
import { getDriverInfo } from "../services/user/driverInfo";
import { claimIfOpen } from "../services/ride/dispatch";
import { departRide, addRiderToCar, FILLABLE_STATUSES } from "../services/ride/assembly";
import { getStoredZoneRoutes, getZoneAdjacency, getZoneMap } from "../services/zones/zoneCache";
import { suggestFillsForRide } from "../services/ride/ranking";
import { applyRideTransition, applyPassengerTransition } from "../services/ride/rideService";
import { ACTIVE_DRIVER_STATUSES, isActivePassengerStatus } from "../services/ride/stateMachine";
import {
  DetourTooLongError,
  InvalidTransitionError,
  NoShowTooEarlyError,
  PassengerNotFoundError,
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
  /** The ride's passengers, when the caller already has them (saves reading them again). */
  passengers?: ReadonlyArray<{ riderId: string; status: string; lockedFare: number | null }>,
): Promise<void> {
  const paymentMethod = ride.paymentMethod as PaymentMethod;

  if (paymentMethod === "CASH") {
    // A shared car's fare is per rider actually carried. occupancy is not
    // that: it drops as seats are cancelled, and a trip that ends by
    // cancelling its last waiting rider completes with occupancy 0 (which
    // getSharedFarePerRider rejects). Same count the ride history uses.
    const carried = passengers?.filter((p) => p.status === "DROPPED_OFF").length ?? ride.occupancy;
    const farePesewasForLedger =
      ride.type === "LONE"
        ? getLoneFare()
        : carried > 0
          ? getSharedFarePerRider(carried) * carried
          : 0;
    const { commission } = splitFare(farePesewasForLedger);
    // createMany + skipDuplicates is a single INSERT … ON CONFLICT DO NOTHING
    // (an upsert is two round trips); repeating it is harmless.
    await prisma.commissionLedger.createMany({
      data: [{ driverUserId, rideId: ride.id, amountPesewas: commission }],
      skipDuplicates: true,
    });
  }

  // A cash ride has no Payment rows, so its per-rider summary is known from
  // the passengers alone; MoMo needs the payment records.
  const perPassenger =
    paymentMethod === "CASH" && passengers
      ? passengers
          .filter((p) => p.status !== "CANCELLED" && p.lockedFare != null)
          .map((p) => ({ riderId: p.riderId, farePesewas: p.lockedFare ?? 0, status: "PENDING" as const }))
      : (await getRidePaymentSummary(prisma, ride.id)).perPassenger;
  const totalFarePesewas = perPassenger.reduce((sum, p) => sum + p.farePesewas, 0);

  for (const p of perPassenger) {
    emitToRider(p.riderId, "ride:completed", {
      rideId: ride.id,
      fareSummary: {
        yourFarePesewas: p.farePesewas,
        totalFarePesewas,
        paymentMethod,
        paymentStatus: p.status,
      },
    });
  }

  // USSD-origin riders have no app to receive ride:completed on, so they get
  // an SMS instead — covers both this ride-level /complete (LONE) and the
  // per-passenger last-dropoff auto-completion, since both call this
  // function. Fire-and-forget, never throws into the transition path.
  if (ride.source === "USSD") {
    void notifyUssdRiders(
      prisma,
      perPassenger.map((p) => p.riderId),
      "Trip complete. Thanks for riding CampusRide.",
    );
  }
}

const DETOUR_TOO_LONG_MESSAGE =
  "Adding this rider would make the riders in your car more than 5 minutes late.";

/** A refusal the driver app shows as-is: plain words plus a stable code. */
function refuse(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code });
}

/**
 * Why a passenger action was refused, in words a driver understands.
 * `from` is the passenger's status when the action arrived.
 */
function passengerRefusal(from: string, to: string): string {
  if (from === "CANCELLED") return "This rider has cancelled.";
  if (from === "DROPPED_OFF") return "This rider has already been dropped off.";
  if (to === "CANCELLED" && from === "ARRIVED") {
    return "You've already arrived. If the rider doesn't come out, use \"Rider didn't show\" after 3 minutes.";
  }
  if (to === "CANCELLED" && from === "PICKED_UP") return "This rider is already in the car. Drop them off instead.";
  if (to === "PICKED_UP" && from === "WAITING") return "Mark that you're at the pickup first.";
  if (to === "DROPPED_OFF") return "This rider hasn't been picked up yet.";
  if (to === "ARRIVED") return "This rider has already been picked up.";
  return "That doesn't fit where this trip is now. Pull down to refresh.";
}

/** Only these PassengerInCar fields go to the app — no internal columns. */
function passengerForApp(
  p: { id: string; riderId: string; pickupZoneId: string; dropoffZoneId: string; lockedFare: number | null; status: string; arrivedAt: Date | null },
  zones: Map<string, { name: string }>,
  rider?: { name: string; phone: string } | null,
) {
  return {
    id: p.id,
    riderId: p.riderId,
    riderName: rider?.name ?? null,
    riderPhone: rider?.phone ?? null,
    pickupZoneId: p.pickupZoneId,
    dropoffZoneId: p.dropoffZoneId,
    pickupZoneName: zones.get(p.pickupZoneId)?.name ?? "",
    dropoffZoneName: zones.get(p.dropoffZoneId)?.name ?? "",
    lockedFare: p.lockedFare,
    status: p.status as PassengerStatus,
    arrivedAt: p.arrivedAt ? p.arrivedAt.toISOString() : null,
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

  /**
   * Keep an online driver's zone current as they move. The app calls this
   * when its GPS lands in a different zone (throttled client-side to about
   * once every 30s — see planZoneUpdate in @rida/shared). Separate from
   * /driver/availability so a zone update can never flip a driver online: an
   * offline driver gets 409 and nothing changes.
   */
  app.patch("/driver/zone", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const body = (request.body ?? {}) as { zoneId?: unknown };
    // null = "I'm outside the service area": no zone, so no requests.
    if (body.zoneId !== null && (typeof body.zoneId !== "string" || body.zoneId.length === 0)) {
      return reply.code(400).send({ error: "zoneId (string, or null to clear it) is required" });
    }
    const zoneId = body.zoneId;

    const userId = request.user!.userId;
    if (zoneId !== null) {
      const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
      if (!zone) return reply.code(404).send({ error: "Zone not found" });
    }

    // Conditional update: only an online driver's zone moves, decided in the
    // same statement as the write so a concurrent "go offline" always wins.
    const { count } = await prisma.driver.updateMany({
      where: { userId, isOnline: true },
      data: { currentZoneId: zoneId },
    });
    if (count === 0) {
      const exists = await prisma.driver.findUnique({ where: { userId }, select: { id: true } });
      if (!exists) return reply.code(404).send({ error: "Driver profile not found" });
      return reply.code(409).send({ error: "You're offline. Go online to receive requests." });
    }

    return reply.code(200).send({ zoneId });
  });

  /**
   * The driver's currently active ride (MATCHED, ARRIVED, or IN_PROGRESS), if
   * any, with every passenger (name, phone, zones, status, arrival time) —
   * everything the trip screen needs. Three queries: the ride, its
   * passengers, their riders; zones come from the in-memory zone cache.
   */
  app.get("/driver/rides/active", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const userId = request.user!.userId;

    const [ride, zones] = await Promise.all([
      prisma.ride.findFirst({
        where: {
          driverId: userId,
          status: { in: [...ACTIVE_DRIVER_STATUSES] },
        },
        include: {
          passengers: {
            orderBy: { createdAt: "asc" },
            include: { rider: { select: { id: true, name: true, phone: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      getZoneMap(prisma),
    ]);

    if (!ride) return reply.code(200).send({ ride: null });

    const { passengers, ...rideFields } = ride;

    // Phase 4: the driver needs to be able to reach their riders at pickup,
    // so each passenger carries a name and phone. Scoped to the driver's OWN
    // active ride and dropped the moment it completes (this route only ever
    // returns a live ride), which keeps rider contact details tied to the
    // trip that justifies them.
    const owner =
      passengers.find((p) => p.riderId === ride.riderId)?.rider ??
      (await prisma.user.findUnique({ where: { id: ride.riderId }, select: { id: true, name: true, phone: true } }));

    return reply.code(200).send({
      ride: {
        ...rideFields,
        pickupZone: zones.get(ride.pickupZoneId) ?? null,
        dropoffZone: zones.get(ride.dropoffZoneId) ?? null,
        // The ride owner, for a LONE ride that has no RidePassenger row.
        riderName: owner?.name ?? null,
        riderPhone: owner?.phone ?? null,
        passengers: passengers.map((p) => passengerForApp(p, zones, p.rider)),
      },
    });
  });

  /**
   * Read-only completed-ride history for the authenticated driver, newest
   * first. Earnings are DERIVED from the fixed fare model (no stored per-ride
   * driver share exists, and the CommissionLedger stores the platform's cut,
   * not the driver's) — gross accrued, not settled/paid out.
   *
   * SHARED gross is derived from the count of riders who actually completed
   * (DROPPED_OFF passengers), not the ride's raw `occupancy`: occupancy is
   * recomputed on cancels and can understate completers when a rider cancels
   * after another has already been dropped off.
   */
  app.get("/driver/rides/history", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const userId = request.user!.userId;

    const rides = await prisma.ride.findMany({
      where: { driverId: userId, status: "COMPLETED" },
      include: {
        pickupZone: { select: { name: true } },
        dropoffZone: { select: { name: true } },
        passengers: { select: { status: true } },
      },
      orderBy: { completedAt: "desc" },
    });

    const items = rides.map((ride) => {
      // LONE: always exactly 1 rider (its ride-level /complete never marks the
      // passenger DROPPED_OFF). SHARED: count the riders who actually finished.
      // Clamp to the valid 1–4 seat range purely defensively — completion
      // guarantees at least one DROPPED_OFF, and seats cap at 4.
      const droppedOff = ride.passengers.filter((p) => p.status === "DROPPED_OFF").length;
      const riders =
        ride.type === "LONE" ? 1 : Math.min(PRICING.MAX_SHARED_OCCUPANCY, Math.max(1, droppedOff));

      const facePesewas = ride.type === "LONE" ? getLoneFare() : getSharedTotalFare(riders);
      const driverGrossPesewas = getDriverGrossForRide(ride.type, riders);

      return {
        rideId: ride.id,
        pickupZoneName: ride.pickupZone.name,
        dropoffZoneName: ride.dropoffZone.name,
        type: ride.type as "LONE" | "SHARED",
        source: ride.source as "APP" | "USSD",
        completedAt: (ride.completedAt ?? ride.createdAt).toISOString(),
        facePesewas,
        driverGrossPesewas,
      };
    });

    // Phase 4: commission owed comes from CommissionLedger — the 15% recorded
    // on each completed CASH ride (see finalizeRideCompletion). It is an
    // unenforced debt record for now, so "owed" here means every row on file,
    // not an unpaid balance; there is no settlement mechanism to net against
    // yet. MOMO rides never create a ledger row (the commission is taken at
    // source), so they contribute gross but no commission.
    const ledger = await prisma.commissionLedger.aggregate({
      where: { driverUserId: userId },
      _sum: { amountPesewas: true },
      _count: true,
    });
    const commissionOwedPesewas = ledger._sum.amountPesewas ?? 0;
    const totalGrossPesewas = items.reduce((sum, i) => sum + i.driverGrossPesewas, 0);

    const summary = {
      totalRides: items.length,
      totalGrossPesewas,
      commissionOwedPesewas,
      /**
       * What the driver actually keeps: gross minus the commission recorded
       * against them. Can go negative in principle (a driver whose only rides
       * were cash and who has taken no payouts), so it is not clamped —
       * showing a negative number is more honest than hiding a debt.
       */
      netPesewas: totalGrossPesewas - commissionOwedPesewas,
      commissionRidesCount: ledger._count,
    };

    return reply.code(200).send({ rides: items, summary });
  });

  /**
   * Partial profile update for the authenticated driver — name (on User) and
   * vehicle fields + photoUrl (on Driver), each optional. Pure profile CRUD;
   * no money or state-machine effects.
   *
   * Every provided field must be a non-empty string: rejecting an empty name
   * preserves the required-name invariant, and rejecting empty vehicle fields
   * preserves the "complete profile" invariant that going online depends on
   * (see PATCH /driver/availability). Fields that are omitted are left as-is.
   */
  app.patch("/driver/profile", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const userId = request.user!.userId;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const TEXT_FIELDS = ["name", "carMake", "carModel", "carColor", "plate", "photoUrl"] as const;
    type TextField = (typeof TEXT_FIELDS)[number];

    // Collect only the keys actually present in the body. A present field must
    // be a non-empty (post-trim) string, else 400 — never silently dropped.
    const provided: Partial<Record<TextField, string>> = {};
    for (const field of TEXT_FIELDS) {
      if (!(field in body)) continue;
      const value = body[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        return reply.code(400).send({ error: `${field} must be a non-empty string` });
      }
      // Plate is normalized to uppercase to match onboarding (completeDriverProfile).
      provided[field] = field === "plate" ? value.trim().toUpperCase() : value.trim();
    }

    if (Object.keys(provided).length === 0) {
      return reply.code(400).send({ error: "At least one field is required to update" });
    }

    // A photoUrl is reported by the client AFTER it uploads to Cloudinary, so
    // it must be checked rather than trusted: without this a driver could
    // point their profile photo at any URL on the internet. A real upload
    // always lands on our Cloudinary account under this driver's own signed
    // public id (services/uploads/cloudinarySignature.ts). Skipped entirely
    // when Cloudinary is unconfigured, so local dev can still set a photo.
    if (provided.photoUrl !== undefined && config.cloudinary.cloudName) {
      if (!isValidDriverPhotoUrl(provided.photoUrl, config.cloudinary.cloudName, userId)) {
        request.log.warn(
          { event: "driver_profile_save_failed", reason: "invalid_photo_url", userId, photoUrl: provided.photoUrl },
          "Driver profile update refused: photoUrl is not this driver's Cloudinary upload",
        );
        return reply.code(400).send({
          error: "photoUrl must be an image uploaded through this app",
          code: "INVALID_PHOTO_URL",
        });
      }
    }

    const { name, ...driverFields } = provided;

    const user = await prisma.$transaction(async (tx) => {
      if (name !== undefined) {
        await tx.user.update({ where: { id: userId }, data: { name } });
      }
      if (Object.keys(driverFields).length > 0) {
        await tx.driver.update({ where: { userId }, data: driverFields });
      }
      return tx.user.findUniqueOrThrow({ where: { id: userId }, include: { driver: true } });
    });

    request.log.info(
      { event: "driver_profile_saved", userId, fields: Object.keys(provided) },
      "Driver profile updated",
    );
    const driver = user.driver;
    return reply.code(200).send({
      profile: {
        name: user.name,
        phone: user.phone,
        carMake: driver?.carMake ?? null,
        carModel: driver?.carModel ?? null,
        carColor: driver?.carColor ?? null,
        plate: driver?.plate ?? null,
        photoUrl: driver?.photoUrl ?? null,
        isApproved: driver?.isApproved ?? false,
        isOnline: driver?.isOnline ?? false,
      },
    });
  });

  /**
   * Atomically claim a REQUESTED ride (first-to-claim-wins).
   *
   * Two queries: one reads the driver's standing and any trip they already
   * hold, one claims the ride and returns it. The rider is told
   * (ride:driver_assigned) AFTER the reply, so building that payload never
   * delays the driver.
   *
   * Safe to retry: claiming a ride this driver already holds answers 200 —
   * the app retries after a timeout, and the first attempt often landed.
   */
  app.post("/rides/:id/claim", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const [standing] = await prisma.$queryRaw<
      Array<{ isApproved: boolean; isOnline: boolean; activeRideId: string | null }>
    >`
      SELECT d."isApproved", d."isOnline",
        (SELECT r.id FROM "Ride" r
          WHERE r."driverId" = ${userId} AND r.status IN ('MATCHED', 'ARRIVED', 'IN_PROGRESS')
          ORDER BY r."createdAt" DESC LIMIT 1) AS "activeRideId"
      FROM "Driver" d WHERE d."userId" = ${userId}`;

    if (standing?.activeRideId === rideId) {
      const ride = await prisma.ride.findUniqueOrThrow({ where: { id: rideId } });
      return reply.code(200).send({ ride });
    }
    if (!standing?.isApproved || !standing.isOnline) {
      return refuse(reply, 403, "NOT_ONLINE", "Go online to accept requests.");
    }
    if (standing.activeRideId) {
      return reply.code(409).send({
        error: "You already have a trip. Finish it before accepting another request.",
        code: "DRIVER_HAS_ACTIVE_RIDE",
        existingRide: { id: standing.activeRideId },
      });
    }

    const ride = await claimIfOpen(prisma, rideId, userId);
    if (!ride) {
      return refuse(
        reply,
        409,
        "RIDE_NOT_AVAILABLE",
        "Another driver accepted this request first, or the rider cancelled it.",
      );
    }

    reply.code(200).send({ ride });

    void (async () => {
      emitRideEvent(rideId, "ride:status", { rideId, status: ride.status });
      const driverInfo = await getDriverInfo(prisma, userId);
      if (driverInfo) emitRideEvent(rideId, "ride:driver_assigned", { rideId, ...driverInfo });
      if (ride.source === "USSD") {
        void notifyUssdRider(prisma, ride.riderId, "Driver matched! They're on the way.");
      }
    })().catch((err) => request.log.warn({ err, rideId }, "claim: rider notification failed"));
    return reply;
  });

  /**
   * Phase 4: the driver explicitly declines a broadcast ride.
   *
   * Before this, a driver could only ignore a request and let the 90s
   * dispatch window expire — indistinguishable from a driver who never saw
   * it, and the request kept occupying their list until it timed out. A
   * rejection removes it from THIS driver's eligible list immediately and
   * leaves it untouched for everyone else; it never cancels the ride.
   *
   * Idempotent: re-rejecting is a no-op success rather than a 409, because a
   * double-tap or a retry on a flaky connection is not an error the driver
   * should have to think about.
   */
  app.post("/rides/:id/reject", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) return reply.code(404).send({ error: "Ride not found" });

    // Only an unclaimed request can be declined. Once a driver has claimed a
    // ride, walking away is a CANCEL (with its own rules and rider-facing
    // consequences), not a reject.
    if (ride.driverId !== null) {
      return reply.code(409).send({ error: "Ride has already been claimed" });
    }
    if (ride.status !== "REQUESTED" && ride.status !== "AWAITING_RIDER_DECISION") {
      return reply.code(409).send({ error: "Ride is no longer open for offers" });
    }

    await prisma.rideRejection.upsert({
      where: { rideId_driverUserId: { rideId, driverUserId: userId } },
      update: {},
      create: { rideId, driverUserId: userId },
    });

    return reply.code(200).send({ rejected: true, rideId });
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

    // Adjacency and zones never change at runtime: served from memory.
    const [allAdjacencies, zoneMap] = await Promise.all([getZoneAdjacency(prisma), getZoneMap(prisma)]);

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
        // Phase 4: hide rides THIS driver explicitly declined. Scoped to the
        // rejecting driver only — the ride stays live for everyone else, which
        // is the whole point of an explicit reject over letting it time out.
        rejections: { none: { driverUserId: userId } },
      },
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
        pickupZoneName: zoneMap.get(ride.pickupZoneId)?.name ?? "",
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneName: zoneMap.get(ride.dropoffZoneId)?.name ?? "",
        dropoffZoneId: ride.dropoffZoneId,
        type: ride.type as "LONE" | "SHARED",
        /** Riders on this request (a fresh request is its requester alone). */
        seats: ride.occupancy,
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

    const [anchor, allCandidates, adjacency, zones] = await Promise.all([
      prisma.ride.findUnique({
        where: { id: rideId },
        include: { passengers: { orderBy: { createdAt: "asc" } } },
      }),
      prisma.ride.findMany({
        where: { status: "REQUESTED", driverId: null, type: "SHARED" },
        orderBy: { createdAt: "desc" },
      }),
      getZoneAdjacency(prisma),
      getZoneMap(prisma),
    ]);
    if (!anchor) return reply.code(404).send({ error: "Ride not found" });
    if (anchor.driverId !== userId) return reply.code(403).send({ error: "Forbidden" });
    if (anchor.type !== "SHARED") return reply.code(400).send({ error: "Ride is not SHARED" });
    if (!(FILLABLE_STATUSES as readonly string[]).includes(anchor.status)) {
      return reply.code(400).send({ error: "Riders can't be added to this trip now" });
    }

    // suggestFillsForRide's internal areCombinable filter is exactly what
    // makes this the "compatible, ranked" subset — left untouched.
    const compatibleRanked = suggestFillsForRide(anchor, allCandidates, adjacency, new Date());
    const compatibleIds = new Set(compatibleRanked.map((r) => r.id));
    const byId = new Map(allCandidates.map((r) => [r.id, r]));
    const existingRiderIds = new Set(anchor.passengers.map((p) => p.riderId));
    const isFull = anchor.occupancy >= PRICING.MAX_SHARED_OCCUPANCY;

    const toSuggestion = (r: (typeof allCandidates)[number], compatible: boolean) => ({
      requestRideId: r.id,
      pickupZoneName: zones.get(r.pickupZoneId)?.name ?? "",
      pickupZoneId: r.pickupZoneId,
      dropoffZoneName: zones.get(r.dropoffZoneId)?.name ?? "",
      dropoffZoneId: r.dropoffZoneId,
      createdAt: r.createdAt.toISOString(),
      compatible,
    });

    const suggestions = isFull
      ? []
      : [
          ...compatibleRanked
            .map((r) => byId.get(r.id))
            .filter((r): r is NonNullable<typeof r> => r !== undefined)
            .map((r) => toSuggestion(r, true)),
          ...allCandidates
            .filter((r) => !compatibleIds.has(r.id) && !existingRiderIds.has(r.riderId))
            .map((r) => toSuggestion(r, false)),
        ];

    // isActivePassengerStatus (WAITING/ARRIVED/PICKED_UP) — a passenger the
    // driver has marked ARRIVED still occupies a seat.
    const currentPassengers = anchor.passengers
      .filter((p) => isActivePassengerStatus(p.status))
      .map((p) => passengerForApp(p, zones));

    return reply.code(200).send({
      occupancy: anchor.occupancy,
      passengers: currentPassengers,
      suggestions,
    });
  });

  /**
   * Route preview before adding a rider: where the new pickup and drop-off
   * would slot into this car's stop order, the route as it is and as it
   * would be (built from the stored zone-to-zone routes), the time it adds
   * and the extra fare. Read-only.
   *
   * Query: requestRideId (required), lat/lng (the driver's position; without
   * it the plan starts at the first stop).
   *
   * Uses previewAddRider from @rida/shared — the same stop ordering the trip
   * screen uses — so the preview is exactly what the car looks like after
   * "Add". Refuses (409, same codes as add-passenger) when the rider could
   * not be added right now, so the app only ever previews an add that would
   * succeed.
   */
  app.get("/rides/:id/add-preview", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;
    const query = (request.query ?? {}) as { requestRideId?: unknown; lat?: unknown; lng?: unknown };
    if (typeof query.requestRideId !== "string" || query.requestRideId.length === 0) {
      return reply.code(400).send({ error: "requestRideId is required" });
    }
    const lat = Number(query.lat);
    const lng = Number(query.lng);
    const from =
      query.lat !== undefined && query.lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)
        ? { latitude: lat, longitude: lng }
        : null;

    const [car, requestRide, zones, storedRoutes] = await Promise.all([
      prisma.ride.findUnique({
        where: { id: rideId },
        include: {
          passengers: {
            orderBy: { createdAt: "asc" },
            include: { rider: { select: { name: true } } },
          },
        },
      }),
      prisma.ride.findUnique({ where: { id: query.requestRideId } }),
      getZoneMap(prisma),
      getStoredZoneRoutes(prisma),
    ]);

    if (!car) return reply.code(404).send({ error: "Ride not found" });
    if (car.driverId !== userId) return refuse(reply, 403, "NOT_YOUR_RIDE", "This trip belongs to another driver.");
    if (car.type !== "SHARED" || !(FILLABLE_STATUSES as readonly string[]).includes(car.status)) {
      return refuse(reply, 409, "CAR_CLOSED", "Riders can't be added to this trip now.");
    }
    const seated = car.passengers.filter((p) => isActivePassengerStatus(p.status)).length;
    if (seated >= PRICING.MAX_SHARED_OCCUPANCY) return refuse(reply, 409, "CAR_FULL", "Your car is full.");
    if (
      !requestRide ||
      requestRide.status !== "REQUESTED" ||
      requestRide.driverId !== null ||
      requestRide.type !== "SHARED"
    ) {
      return refuse(
        reply,
        409,
        "REQUEST_UNAVAILABLE",
        "This rider's request is no longer open — another driver took it or the rider cancelled.",
      );
    }

    const farePesewas = getSharedFarePerRider(1);
    const preview = previewAddRider({
      passengers: car.passengers.map((p) => ({
        id: p.id,
        riderName: p.rider.name,
        pickupZoneId: p.pickupZoneId,
        dropoffZoneId: p.dropoffZoneId,
        lockedFare: p.lockedFare,
        status: p.status as PassengerStatus,
        arrivedAt: p.arrivedAt?.toISOString() ?? null,
      })),
      candidate: {
        requestRideId: requestRide.id,
        pickupZoneId: requestRide.pickupZoneId,
        dropoffZoneId: requestRide.dropoffZoneId,
        farePesewas,
      },
      zones: [...zones.values()],
      routes: indexRoutes(storedRoutes),
      from,
    });
    if (!preview) return reply.code(404).send({ error: "Zone not found" });
    if (!preview.withinDetourLimit) {
      return refuse(reply, 409, "DETOUR_TOO_LONG", DETOUR_TOO_LONG_MESSAGE);
    }

    const startedAt = (requestRide.broadcastStartedAt ?? requestRide.createdAt).getTime();
    return reply.code(200).send({
      requestRideId: requestRide.id,
      pickupZoneName: zones.get(requestRide.pickupZoneId)?.name ?? "",
      dropoffZoneName: zones.get(requestRide.dropoffZoneId)?.name ?? "",
      farePesewas,
      driverSharePesewas: splitFare(farePesewas).driverShare,
      addedSeconds: Math.round(preview.addedSeconds),
      addedMinutes: preview.addedMinutes,
      /** How much later the most-delayed rider already in the car is dropped off. */
      maxOnboardDelayMinutes: Math.ceil(preview.maxOnboardDelaySeconds / 60),
      expiresAt: new Date(startedAt + DISPATCH_WINDOW_MS).toISOString(),
      pickupIndex: preview.pickupIndex,
      dropoffIndex: preview.dropoffIndex,
      stops: preview.stops.map((st) => ({
        key: st.key,
        kind: st.kind,
        isNew: st.isNew,
        riderFirstName: st.riderFirstName,
        zoneId: st.zone.id,
        zoneName: st.zone.name,
        latitude: st.zone.latitude,
        longitude: st.zone.longitude,
      })),
      currentPolyline: encodePolyline(preview.currentPath),
      proposedPolyline: encodePolyline(preview.proposedPath),
    });
  });

  /**
   * Driver adds a pending SHARED request to their claimed car. Wraps the
   * atomic, car-locking `addRiderToCar`. Safe to retry: adding a rider who is
   * already in this car answers 200.
   */
  app.post("/rides/:id/add-passenger", { preHandler: requireAuth }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;
    const body = (request.body ?? {}) as { requestRideId?: unknown; lat?: unknown; lng?: unknown };

    if (typeof body.requestRideId !== "string" || body.requestRideId.length === 0) {
      return reply.code(400).send({ error: "requestRideId (string) is required" });
    }
    const requestRideId = body.requestRideId;
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const from = Number.isFinite(lat) && Number.isFinite(lng) && body.lat !== undefined ? { latitude: lat, longitude: lng } : null;

    try {
      const [zones, storedRoutes] = await Promise.all([getZoneMap(prisma), getStoredZoneRoutes(prisma)]);
      // Worked out inside the transaction, with the car locked, so it is
      // exactly the car the rider joins.
      let onboardDelaySeconds: Record<string, number> = {};
      const car = await addRiderToCar(prisma, userId, rideId, requestRideId, {
        checkCar: ({ passengers, candidate }) => {
          const preview = previewAddRider({
            passengers: passengers.map((p) => ({
              id: p.id,
              pickupZoneId: p.pickupZoneId,
              dropoffZoneId: p.dropoffZoneId,
              lockedFare: p.lockedFare,
              status: p.status as PassengerStatus,
            })),
            candidate: { requestRideId, ...candidate, farePesewas: getSharedFarePerRider(1) },
            zones: [...zones.values()],
            routes: indexRoutes(storedRoutes),
            from,
          });
          if (preview && !preview.withinDetourLimit) throw new DetourTooLongError(preview.maxOnboardDelaySeconds);
          onboardDelaySeconds = preview?.onboardDelaySeconds ?? {};
        },
      });

      if (car.changed) {
        // #7 merged-rider reach: the absorbed request is now CANCELLED /
        // MERGED_INTO_ANOTHER_RIDE. That rider's app is still tracking it, so
        // tell its room — the client follows mergedIntoRideId to this car.
        emitRideEvent(requestRideId, "ride:status", { rideId: requestRideId, status: "CANCELLED" });
        // Riders already in the car hear about the detour.
        for (const p of car.passengers) {
          const delay = onboardDelaySeconds[p.id];
          if (p.status !== "PICKED_UP" || delay === undefined) continue;
          emitToRider(p.riderId, "ride:car_notice", {
            rideId,
            message: onboardAddNotice(delay),
            delayMinutes: Math.max(1, Math.round(delay / 60)),
          });
        }
      }

      return reply.code(200).send({
        occupancy: car.occupancy,
        passengers: car.passengers
          .filter((p) => isActivePassengerStatus(p.status))
          .map((p) => passengerForApp(p, zones)),
      });
    } catch (err) {
      if (err instanceof NotRideOwnerError) {
        return refuse(reply, 403, "NOT_YOUR_RIDE", "This trip belongs to another driver.");
      }
      if (err instanceof RideNotFillableError) {
        return refuse(reply, 409, "CAR_CLOSED", "Riders can't be added to this trip now.");
      }
      if (err instanceof DetourTooLongError) {
        return refuse(reply, 409, "DETOUR_TOO_LONG", DETOUR_TOO_LONG_MESSAGE);
      }
      if (err instanceof NoSeatsAvailableError) {
        return refuse(reply, 409, "CAR_FULL", "Your car is full.");
      }
      if (err instanceof RequestRideUnavailableError) {
        return refuse(
          reply,
          409,
          "REQUEST_UNAVAILABLE",
          "This rider's request is no longer open — another driver took it or the rider cancelled.",
        );
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
   * Per-passenger lifecycle: the four actions on one rider's seat, plus
   * "rider didn't show". Used for Ride alone and Shared trips alike (the
   * stop-based trip screen drives both through these).
   *
   * - arrived  WAITING -> ARRIVED     (first one also moves a MATCHED ride to ARRIVED)
   * - pickup   ARRIVED -> PICKED_UP   (first one walks the ride to IN_PROGRESS)
   * - dropoff  PICKED_UP -> DROPPED_OFF (last one completes the ride)
   * - cancel   WAITING -> CANCELLED   (not once "I'm here" is tapped)
   * - no-show  ARRIVED -> CANCELLED   (3 minutes after arriving)
   *
   * Every one is safe to repeat: asking for the status the rider already has
   * answers 200 and changes nothing. Refusals come back as { error, code }
   * with the reason in plain words. Rider notifications go out after the
   * commit and never hold up the reply.
   */
  const PASSENGER_ACTIONS: Record<
    string,
    { to: PassengerStatus; onlyFrom?: PassengerStatus[]; noShow?: boolean }
  > = {
    arrived: { to: "ARRIVED" },
    pickup: { to: "PICKED_UP" },
    dropoff: { to: "DROPPED_OFF" },
    cancel: { to: "CANCELLED", onlyFrom: ["WAITING"] },
    // Older app builds; the app now sends cancel with { reason: "NO_SHOW" }.
    "no-show": { to: "CANCELLED", onlyFrom: ["ARRIVED"], noShow: true },
  };
  const NO_SHOW_CANCEL = PASSENGER_ACTIONS["no-show"]!;

  for (const [action, baseSpec] of Object.entries(PASSENGER_ACTIONS)) {
    app.post(`/rides/:id/passengers/:passengerId/${action}`, { preHandler: requireAuth }, async (request, reply) => {
      if (!(await requireDriver(request, reply))) return;

      const { id: rideId, passengerId } = request.params as { id: string; passengerId: string };
      const userId = request.user!.userId;
      // "Rider didn't show" is the passenger cancel with a no-show reason
      // (allowed from ARRIVED, 3 minutes after arriving).
      const reason = (request.body as { reason?: unknown } | undefined)?.reason;
      const spec = action === "cancel" && reason === "NO_SHOW" ? NO_SHOW_CANCEL : baseSpec;

      let result;
      try {
        result = await applyPassengerTransition(prisma, passengerId, spec.to, new Date(), {
          expectedRideId: rideId,
          expectedDriverId: userId,
          onlyFrom: spec.onlyFrom,
          noShow: spec.noShow,
        });
      } catch (err) {
        if (err instanceof PassengerNotFoundError) {
          return refuse(reply, 404, "PASSENGER_NOT_FOUND", "This rider is no longer on your trip.");
        }
        if (err instanceof NotRideOwnerError) {
          return refuse(reply, 403, "NOT_YOUR_RIDE", "This trip belongs to another driver.");
        }
        if (err instanceof NoShowTooEarlyError) {
          const wait = err.availableAt ? Math.max(1, Math.ceil((err.availableAt.getTime() - Date.now()) / 60_000)) : null;
          return refuse(
            reply,
            409,
            "NO_SHOW_TOO_EARLY",
            wait
              ? `Give the rider a little longer — you can mark a no-show in ${wait} min.`
              : "Mark that you're at the pickup first.",
          );
        }
        if (err instanceof InvalidTransitionError) {
          if (err.entity === "Ride") {
            return refuse(reply, 409, "TRIP_ENDED", "This trip has already ended.");
          }
          return refuse(reply, 409, "INVALID_PASSENGER_STATE", passengerRefusal(err.from, err.to));
        }
        throw err;
      }

      const { passenger, ride, changed, rideStatusBefore } = result;
      reply.code(200).send({ passenger, ride });
      if (!changed) return reply;

      // After the reply: tell the rider(s). Never blocks or fails the action.
      void (async () => {
        emitToRider(passenger.riderId, "ride:passenger_status", {
          rideId,
          ridePassengerId: passengerId,
          riderId: passenger.riderId,
          status: passenger.status as PassengerStatus,
        });
        if (ride.status !== rideStatusBefore) {
          emitRideEvent(rideId, "ride:status", { rideId, status: ride.status as RideStatus });
        }
        if (spec.to === "ARRIVED" && ride.source === "USSD") {
          void notifyUssdRider(prisma, passenger.riderId, "Your driver has arrived.");
        }
        if (ride.status === "COMPLETED" && rideStatusBefore !== "COMPLETED") {
          await finalizeRideCompletion(
            prisma,
            { id: ride.id, type: ride.type, occupancy: ride.occupancy, paymentMethod: ride.paymentMethod, source: ride.source },
            userId,
            ride.passengers,
          );
        }
      })().catch((err) => request.log.error({ err, rideId, passengerId }, `passenger ${action}: follow-up failed`));
      return reply;
    });
  }
}
