import type { FastifyInstance, FastifyReply } from "fastify";
import { useRequestValidation } from "../http/validation";
import type { PrismaClient } from "@prisma/client";
import type { PassengerStatus } from "@rida/shared";
import {
  DISPATCH_WINDOW_MS,
  DRIVER_OUTSIDE_AREA_MESSAGE,
  PRICING,
  designateBestFit,
  encodePolyline,
  firstName,
  indexRoutes,
  onboardAddNotice,
  previewAddRider,
  splitFare,
  earningsTotals,
  ROAD_CIRCUITY_FACTOR,
  dropoffPin,
  haversineDistanceMeters,
  isInServiceArea,
  pickupPin,
  straightLineSeconds,
  type RidePinFields,
} from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { isValidDriverPhotoUrl } from "../services/uploads/cloudinarySignature";
import { config } from "../config";
import { claimIfOpen, closeOffer } from "../services/ride/dispatch";
import { paidFareTotal, requestFare } from "../services/ride/fares";
import { departRide, addRiderToCar, FILLABLE_STATUSES } from "../services/ride/assembly";
import { getStoredZoneRoutes, getZoneAdjacency, getZoneMap, servedZoneId } from "../services/zones/zoneCache";
import { suggestFillsForRide } from "../services/ride/ranking";
import { applyRideTransition, applyPassengerTransition } from "../services/ride/rideService";
import { finalizeRideCompletion } from "../services/ride/completion";
import { announceClaim, announcePassengerChange } from "../services/ride/driverActionEvents";
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
  RideNotReadyToDepartError,
} from "../services/ride/errors";
import { emitRideEvent, emitToRider } from "../realtime/rideSocket";
import { notifyUssdRider } from "../services/sms/notifyUssdRiders";
import { notifyRider } from "../services/push/notify";
import { getActivePlaces } from "../services/places/placeCache";
import { approximatePins } from "../services/places/approximatePins";
import { pinFieldsOf, requestPlaceNames } from "./ridePins";
import { estimateRoute } from "../services/routing/campusRoutes";
import { RULES } from "../rateLimit/rules";
import { checkDriverPosition, hasActiveTrip, lastPositionData, parseDriverPoint } from "../services/zones/driverPosition";
import { closeDriverSession, openDriverSession } from "../services/stats/driverSessions";
import { recordOfferAnswer } from "../services/stats/rideOffers";
import {
  MAX,
  bodyOptional,
  boolean,
  empty,
  id,
  idParams,
  latitude,
  longitude,
  noInput,
  nullableId,
  object,
  oneOf,
  text,
} from "../http/schemas";

/** Request schemas (http/schemas.ts): unknown fields are dropped before the handler. */
const SCHEMAS = {
  // latitude/longitude: the driver's position (apps from 2026-10-29); the server checks it.
  availability: { body: object({ isOnline: boolean, zoneId: nullableId, latitude, longitude }, ["isOnline"]) },
  zone: { body: object({ zoneId: nullableId, latitude, longitude }, ["zoneId"]) },
  activeRide: noInput,
  history: noInput,
  profile: {
    body: object({
      name: text(MAX.name),
      carMake: text(MAX.vehicleField),
      carModel: text(MAX.vehicleField),
      carColor: text(MAX.vehicleField),
      plate: text(MAX.plate),
      photoUrl: text(MAX.url),
    }),
  },
  noBodyAction: { params: idParams, body: empty },
  reject: { params: idParams, body: object({ reason: oneOf(["DECLINED", "TIMED_OUT"]) }) },
  eligible: { querystring: object({ lat: latitude, lng: longitude }) },
  fillSuggestions: { params: idParams, querystring: empty },
  addPreview: {
    params: idParams,
    querystring: object({ requestRideId: id, lat: latitude, lng: longitude }, ["requestRideId"]),
  },
  addPassenger: { params: idParams, body: object({ requestRideId: id, lat: latitude, lng: longitude }, ["requestRideId"]) },
  passengerAction: {
    params: object({ id, passengerId: id }, ["id", "passengerId"]),
    body: object({ reason: oneOf(["NO_SHOW"]) }),
  },
};

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

const DETOUR_TOO_LONG_MESSAGE =
  "Adding this rider would make the riders in your car more than 5 minutes late.";

/** A refusal the driver app shows as-is: plain words plus a stable code. */
function refuse(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code });
}

/**
 * Another driver's trip gets exactly the answer a trip that doesn't exist
 * gets, so trying ride ids confirms nothing about other drivers' rides.
 */
function rideNotFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "Ride not found" });
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

/**
 * Only these PassengerInCar fields go to the app — no internal columns.
 * Every caller is the car's own driver, so each rider's exact pins and note
 * are included (that is what the driver navigates to). A rider's phone goes
 * only while they are still to be picked up or in the car: once dropped off
 * or cancelled, the driver has no reason to call them.
 */
function passengerForApp(
  p: { id: string; riderId: string; pickupZoneId: string; dropoffZoneId: string; lockedFare: number | null; status: string; arrivedAt: Date | null } & Partial<RidePinFields>,
  zones: Map<string, { name: string }>,
  rider?: { name: string; phone: string } | null,
) {
  return {
    ...pinFieldsOf(p),
    id: p.id,
    riderId: p.riderId,
    riderName: rider?.name ?? null,
    riderPhone: isActivePassengerStatus(p.status as PassengerStatus) ? (rider?.phone ?? null) : null,
    pickupZoneId: p.pickupZoneId,
    dropoffZoneId: p.dropoffZoneId,
    pickupZoneName: zones.get(p.pickupZoneId)?.name ?? "",
    dropoffZoneName: zones.get(p.dropoffZoneId)?.name ?? "",
    lockedFare: p.lockedFare,
    status: p.status as PassengerStatus,
    arrivedAt: p.arrivedAt ? p.arrivedAt.toISOString() : null,
  };
}

/**
 * The distances a ride offer shows, without giving the pickup away:
 * driver → pickup is measured to the named place the pin is at or near
 * (approximatePins), rounded to 50 m; the trip is the road between the
 * ride's own pins (or zone centres), rounded to 100 m. Numbers only.
 *
 * Both are campus-road routes (services/routing/campusRoutes.ts). Driver →
 * pickup falls back to the straight-line estimate when there's no road
 * route (the driver far from any campus road); the trip then shows none.
 */
async function offerDistances(
  prisma: PrismaClient,
  ride: { pickupZoneId: string; dropoffZoneId: string } & Partial<RidePinFields>,
  from: { latitude: number; longitude: number } | null,
  zones: Map<string, { latitude: number; longitude: number }>,
  places: readonly { id: string; latitude: number; longitude: number }[],
) {
  const pickupZone = zones.get(ride.pickupZoneId);
  const dropoffZone = zones.get(ride.dropoffZoneId);
  const approx = approximatePins(
    { ...pinFieldsOf(ride), pickupZoneId: ride.pickupZoneId, dropoffZoneId: ride.dropoffZoneId },
    zones,
    places,
  );
  const meetAt =
    approx.pickupLat != null && approx.pickupLng != null
      ? { latitude: approx.pickupLat, longitude: approx.pickupLng }
      : pickupZone ?? null;
  const pickupRoad = from && meetAt ? estimateRoute([from, meetAt]) : null;
  const pickupSeconds =
    pickupRoad?.durationSeconds ?? (from && meetAt ? straightLineSeconds(from, meetAt) : null);
  const pickupMeters =
    pickupRoad?.distanceMeters ?? (from && meetAt ? haversineDistanceMeters(from, meetAt) * ROAD_CIRCUITY_FACTOR : null);

  const start = pickupPin(ride) ?? pickupZone ?? null;
  const end = dropoffPin(ride) ?? dropoffZone ?? null;
  const trip = start && end ? estimateRoute([start, end]) : null;
  return {
    pickupDistanceMeters: pickupMeters === null ? null : Math.max(50, Math.round(pickupMeters / 50) * 50),
    pickupMinutes: pickupSeconds === null ? null : Math.max(1, Math.round(pickupSeconds / 60)),
    tripDistanceMeters: trip ? Math.max(100, Math.round(trip.distanceMeters / 100) * 100) : null,
    tripMinutes: trip ? Math.max(1, Math.round(trip.durationSeconds / 60)) : null,
  };
}

export function registerDriverRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  /**
   * Set the driver's online/offline status and current zone.
   * Going online makes the driver eligible for ride broadcasts.
   *
   * With the driver's position (latitude/longitude), the server works out
   * the zone itself (services/zones/driverPosition.ts) and refuses to put a
   * driver outside the service area online — unless they're on a trip,
   * which keeps working (with no zone, so no new requests).
   */
  app.patch("/driver/availability", { onRequest: requireAuth, schema: SCHEMAS.availability }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const body = request.body as { isOnline?: unknown; zoneId?: unknown; latitude?: unknown; longitude?: unknown };
    if (typeof body.isOnline !== "boolean") {
      return reply.code(400).send({ error: "isOnline (boolean) is required" });
    }
    const point = parseDriverPoint(body);
    if (point && "error" in point) return reply.code(400).send({ error: point.error });

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

    const requestedZoneId = typeof body.zoneId === "string" && body.zoneId.length > 0
      ? body.zoneId
      : undefined;

    // A position decides the zone (null outside the area); without one, the
    // app's zone is used as before.
    const position = await checkDriverPosition(prisma, userId, point);
    let zoneId: string | null | undefined;
    if (position.kind === "checked") {
      zoneId = position.zoneId;
      if (body.isOnline && zoneId === null && !(await hasActiveTrip(prisma, userId))) {
        return refuse(reply, 403, "OUTSIDE_SERVICE_AREA", DRIVER_OUTSIDE_AREA_MESSAGE);
      }
    } else if (requestedZoneId) {
      // A retired zone (sent by an app with an old zone list) counts as the
      // in-service zone nearest it: a driver is never in a retired zone.
      zoneId = (await servedZoneId(prisma, requestedZoneId)) ?? undefined;
      if (!zoneId) return reply.code(404).send({ error: "Zone not found" });
    }

    const updated = await prisma.driver.update({
      where: { userId },
      data: {
        isOnline: body.isOnline,
        ...(zoneId !== undefined ? { currentZoneId: zoneId } : {}),
        ...(!body.isOnline ? { currentZoneId: null } : {}),
        // Only an online driver's position is kept.
        ...(body.isOnline ? lastPositionData(position) : {}),
      },
    });
    // Stats: hours online (services/stats/driverSessions.ts).
    if (body.isOnline) await openDriverSession(prisma, userId);
    else await closeDriverSession(prisma, userId, "OFFLINE");

    return reply.code(200).send({ driver: updated });
  });

  /**
   * Keep an online driver's zone current as they move. The app calls this
   * when its GPS lands in a different zone (throttled client-side to about
   * once every 30s — see planZoneUpdate in @rida/shared). Separate from
   * /driver/availability so a zone update can never flip a driver online: an
   * offline driver gets 409 and nothing changes.
   *
   * With the driver's position, the server works out the zone itself: none
   * outside the service area (so no new requests; a trip under way carries on).
   */
  app.patch("/driver/zone", { onRequest: requireAuth, schema: SCHEMAS.zone }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const body = (request.body ?? {}) as { zoneId?: unknown; latitude?: unknown; longitude?: unknown };
    // null = "I'm outside the service area": no zone, so no requests.
    if (body.zoneId !== null && (typeof body.zoneId !== "string" || body.zoneId.length === 0)) {
      return reply.code(400).send({ error: "zoneId (string, or null to clear it) is required" });
    }
    const point = parseDriverPoint(body);
    if (point && "error" in point) return reply.code(400).send({ error: point.error });
    const userId = request.user!.userId;
    const position = await checkDriverPosition(prisma, userId, point);
    let zoneId: string | null;
    if (position.kind === "checked") {
      zoneId = position.zoneId;
    } else {
      // A retired zone counts as the in-service zone nearest it (see /driver/availability).
      zoneId = body.zoneId === null ? null : await servedZoneId(prisma, body.zoneId as string);
      if (body.zoneId !== null && !zoneId) return reply.code(404).send({ error: "Zone not found" });
    }

    // Conditional update: only an online driver's zone moves, decided in the
    // same statement as the write so a concurrent "go offline" always wins.
    const { count } = await prisma.driver.updateMany({
      where: { userId, isOnline: true },
      data: { currentZoneId: zoneId, ...lastPositionData(position) },
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
  app.get("/driver/rides/active", { onRequest: requireAuth, schema: SCHEMAS.activeRide }, async (request, reply) => {
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
    const ownerSeat = passengers.find((p) => p.riderId === ride.riderId);
    const owner =
      ownerSeat?.rider ??
      (await prisma.user.findUnique({ where: { id: ride.riderId }, select: { id: true, name: true, phone: true } }));
    const ownerStillAboard = !ownerSeat || isActivePassengerStatus(ownerSeat.status);

    return reply.code(200).send({
      ride: {
        ...rideFields,
        pickupZone: zones.get(ride.pickupZoneId) ?? null,
        dropoffZone: zones.get(ride.dropoffZoneId) ?? null,
        // The ride owner, for a LONE ride that has no RidePassenger row.
        riderName: owner?.name ?? null,
        riderPhone: ownerStillAboard ? (owner?.phone ?? null) : null,
        passengers: passengers.map((p) => passengerForApp(p, zones, p.rider)),
      },
    });
  });

  /**
   * Read-only completed-ride history for the authenticated driver, newest
   * first. Per ride: `facePesewas` is the FARE riders paid — the fares stored
   * on the seats they were carried in (services/ride/fares), so a trip keeps
   * the price it was booked at after the price list changes — and
   * `driverGrossPesewas` (an older name) is the driver's 85% SHARE of it.
   *
   * SHARED counts the riders who actually completed (DROPPED_OFF), not the
   * ride's raw `occupancy`: occupancy is recomputed on cancels and can
   * understate completers when a rider cancels after another has already
   * been dropped off.
   */
  app.get("/driver/rides/history", { onRequest: requireAuth, schema: SCHEMAS.history }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const userId = request.user!.userId;

    const rides = await prisma.ride.findMany({
      where: { driverId: userId, status: "COMPLETED" },
      include: {
        pickupZone: { select: { name: true } },
        dropoffZone: { select: { name: true } },
        passengers: { select: { status: true, lockedFare: true, fareCharged: true } },
      },
      orderBy: { completedAt: "desc" },
    });

    const items = rides.map((ride) => {
      const facePesewas = paidFareTotal(ride.type, ride.passengers);
      const driverGrossPesewas = splitFare(facePesewas).driverShare;

      return {
        rideId: ride.id,
        pickupZoneName: ride.pickupZone.name,
        dropoffZoneName: ride.dropoffZone.name,
        // The trip is over: where it went, by name only.
        ...requestPlaceNames(ride, ride.pickupZone.name, ride.dropoffZone.name),
        type: ride.type as "LONE" | "SHARED",
        source: ride.source as "APP" | "USSD",
        completedAt: (ride.completedAt ?? ride.createdAt).toISOString(),
        facePesewas,
        driverGrossPesewas,
      };
    });

    // The summary follows the ONE earnings rule the driver app uses too
    // (earningsTotals, @rida/shared): gross = the fares, commission = 15% of
    // them, net = the driver's shares. The commission comes out once.
    const totals = earningsTotals(items);

    // Phase 4: commission OWED comes from CommissionLedger — the 15% recorded
    // on each completed CASH ride (see finalizeRideCompletion): the driver
    // collected the whole fare in cash and owes CampusRide its share. An
    // unenforced debt record for now (no settlement mechanism yet). MOMO rides
    // never create a ledger row (the commission is taken at source). It is
    // shown beside the totals, never subtracted from the driver's share again.
    const ledger = await prisma.commissionLedger.aggregate({
      where: { driverUserId: userId },
      _sum: { amountPesewas: true },
      _count: true,
    });

    const summary = {
      totalRides: totals.trips,
      /** The fares riders paid, all time. */
      totalGrossPesewas: totals.grossPesewas,
      /** CampusRide's 15% of those fares. */
      totalCommissionPesewas: totals.commissionPesewas,
      /** Of that, what's on file as owed from cash rides. */
      commissionOwedPesewas: ledger._sum.amountPesewas ?? 0,
      /** What the driver keeps after commission: the sum of their 85% shares. */
      netPesewas: totals.netPesewas,
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
  app.patch(
    "/driver/profile",
    { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.profile, config: { limits: { user: [RULES.profile] } } },
    async (request, reply) => {
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
  app.post(
    "/rides/:id/claim",
    { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.noBodyAction, config: { limits: { user: [RULES.driverAccept] } } },
    async (request, reply) => {
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
      // Say which: the pop-up closes with "Ride taken by another driver",
      // not a vague "unavailable". One extra read, on the losing path only.
      const gone = await prisma.ride.findUnique({ where: { id: rideId }, select: { status: true, driverId: true, cancelReason: true } });
      const reason =
        gone?.driverId || gone?.cancelReason === "MERGED_INTO_ANOTHER_RIDE"
          ? "TAKEN"
          : gone?.status === "CANCELLED"
            ? "CANCELLED"
            : "EXPIRED";
      return reply.code(409).send({
        code: "RIDE_NOT_AVAILABLE",
        reason,
        error:
          reason === "TAKEN"
            ? "Ride taken by another driver."
            : reason === "CANCELLED"
              ? "The rider cancelled this request."
              : "This request has expired.",
      });
    }

    reply.code(200).send({ ride });

    announceClaim(prisma, ride, userId).catch((err) => request.log.warn({ err, rideId }, "claim: rider notification failed"));
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
   *
   * Ride offers (2026-10): body `{ reason: "DECLINED" | "TIMED_OUT" }` says
   * whether the driver tapped Decline or let the countdown run out (default
   * DECLINED). Stored for stats — never a penalty. Either way the ride is
   * never offered to this driver again (eligible list, broadcast,
   * fill-suggestions all skip it).
   */
  app.post(
    "/rides/:id/reject",
    { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.reject, config: { limits: { user: [RULES.driverDecline] } } },
    async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;
    const rawReason = (request.body as { reason?: unknown } | undefined)?.reason;
    if (rawReason !== undefined && rawReason !== "DECLINED" && rawReason !== "TIMED_OUT") {
      return reply.code(400).send({ error: "reason must be DECLINED or TIMED_OUT" });
    }
    const reason = rawReason ?? "DECLINED";

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

    // The first answer stands (a retry, or a timeout racing a tap, changes nothing).
    await prisma.rideRejection.upsert({
      where: { rideId_driverUserId: { rideId, driverUserId: userId } },
      update: {},
      create: { rideId, driverUserId: userId, reason },
    });
    void recordOfferAnswer(prisma, rideId, userId, reason === "TIMED_OUT" ? "TIMED_OUT" : "DECLINED");

    return reply.code(200).send({ rejected: true, rideId });
  });

  /** Driver has arrived at the pickup zone — transitions MATCHED → ARRIVED. */
  app.post("/rides/:id/arrived", { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.noBodyAction }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride || ride.driverId !== userId) return rideNotFound(reply);

    try {
      const updated = await applyRideTransition(prisma, rideId, "ARRIVED");
      emitRideEvent(rideId, "ride:status", { rideId, status: updated.status });
      notifyRider(prisma, updated.riderId, "DRIVER_ARRIVED", rideId, { driverUserId: userId });
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
  app.post("/rides/:id/depart", { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.noBodyAction }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    // Ownership first: nothing about another driver's ride (not even its
    // type) is answered.
    const existingRide = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!existingRide || existingRide.driverId !== userId) return rideNotFound(reply);
    if (existingRide.type === "SHARED") {
      return reply
        .code(409)
        .send({ error: "SHARED rides depart automatically on the first passenger pickup" });
    }

    try {
      const updated = await departRide(prisma, userId, rideId);
      emitRideEvent(rideId, "ride:status", { rideId, status: updated.status });
      notifyRider(prisma, updated.riderId, "TRIP_STARTED", rideId);
      return reply.code(200).send({ ride: updated });
    } catch (err) {
      if (err instanceof InvalidTransitionError || err instanceof RideNotReadyToDepartError) {
        return reply.code(409).send({ error: "Invalid transition from current ride status" });
      }
      if (err instanceof NotRideOwnerError) return rideNotFound(reply);
      throw err;
    }
  });

  /**
   * Returns the list of REQUESTED rides this driver is currently eligible to claim.
   * Eligible = ride's pickupZone is in the driver's zone or an adjacent zone, ride is
   * unclaimed, and the broadcast window (90 s) hasn't expired. Each ride includes a
   * `bestFit` flag derived from the existing Phase-2e bestFit scoring logic.
   */
  app.get("/driver/rides/eligible", { onRequest: requireAuth, schema: SCHEMAS.eligible }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const userId = request.user!.userId;
    // The driver's own position (ride offers): distances to each pickup are
    // measured from it. Optional; without it, from their zone's centre.
    const query = (request.query ?? {}) as { lat?: unknown; lng?: unknown };
    const qLat = Number(query.lat);
    const qLng = Number(query.lng);
    const driverPoint =
      query.lat !== undefined && query.lng !== undefined && Number.isFinite(qLat) && Number.isFinite(qLng)
        ? { latitude: qLat, longitude: qLng }
        : null;

    // The driver's standing and whether they're already on a trip, in one
    // read. A driver on a trip is offered nothing here (they couldn't accept
    // it); a shared car's free seats are offered on the trip screen
    // (fill-suggestions), within the detour limit.
    const [driver] = await prisma.$queryRaw<
      Array<{ isApproved: boolean; isOnline: boolean; currentZoneId: string | null; busy: boolean; isReviewDemo: boolean }>
    >`
      SELECT d."isApproved", d."isOnline", d."currentZoneId",
        EXISTS (SELECT 1 FROM "Ride" r
          WHERE r."driverId" = ${userId} AND r.status IN ('MATCHED', 'ARRIVED', 'IN_PROGRESS')) AS busy,
        (SELECT u."isReviewDemo" FROM "User" u WHERE u.id = d."userId") AS "isReviewDemo"
      FROM "Driver" d WHERE d."userId" = ${userId}`;
    // A review demo driver sees demo requests wherever they are (services/reviewDemo).
    if (!driver || !driver.isOnline || !driver.isApproved || (!driver.currentZoneId && !driver.isReviewDemo) || driver.busy) {
      return reply.code(200).send({ rides: [] });
    }
    // Off campus by its own position: no offers, even before the zone update lands.
    if (driverPoint && !driver.isReviewDemo && !isInServiceArea(driverPoint)) {
      return reply.code(200).send({ rides: [] });
    }

    // Adjacency and zones never change at runtime: served from memory.
    const [allAdjacencies, zoneMap] = await Promise.all([getZoneAdjacency(prisma), getZoneMap(prisma)]);

    // Zones where this driver is eligible to pick up.
    const driverEligibleZones = driver.currentZoneId ? computeEligibleZoneSet(driver.currentZoneId, allAdjacencies) : new Set<string>();

    // All unclaimed REQUESTED rides whose pickup is in those zones and are still within
    // the 90-second broadcast window.
    const BROADCAST_WINDOW_MS = 90_000;
    const cutoff = new Date(Date.now() - BROADCAST_WINDOW_MS);

    const rides = await prisma.ride.findMany({
      where: {
        status: "REQUESTED",
        driverId: null,
        // Demo requests for demo drivers only, real ones for real drivers only.
        isReviewDemo: driver.isReviewDemo,
        ...(driver.isReviewDemo ? {} : { pickupZoneId: { in: Array.from(driverEligibleZones) } }),
        broadcastStartedAt: { gte: cutoff },
        // Phase 4: hide rides THIS driver explicitly declined. Scoped to the
        // rejecting driver only — the ride stays live for everyone else, which
        // is the whole point of an explicit reject over letting it time out.
        rejections: { none: { driverUserId: userId } },
      },
      // First name only, so the trip can say "Pick up Ama" from the moment
      // the driver accepts; the seat for the fare the rider was quoted.
      include: {
        rider: { select: { name: true } },
        passengers: { select: { riderId: true, status: true, lockedFare: true } },
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

    // Riders' ratings (as given by drivers) and, for rides with pins, the
    // named places to measure to — never the pins themselves.
    const anyPins = rides.some((r) => r.pickupLat != null);
    const [allEligibleDrivers, ratings, places] = await Promise.all([
      prisma.driver.findMany({
        where: {
          isOnline: true,
          isApproved: true,
          currentZoneId: { in: Array.from(allRideEligibleZones) },
        },
        select: { userId: true, currentZoneId: true },
      }),
      prisma.rating.groupBy({
        by: ["rateeId"],
        where: { rateeId: { in: [...new Set(rides.map((r) => r.riderId))] } },
        _avg: { stars: true },
      }),
      anyPins ? getActivePlaces(prisma) : Promise.resolve([]),
    ]);
    const ratingOf = new Map(ratings.map((r) => [r.rateeId, r._avg.stars]));
    const from = driverPoint ?? zoneMap.get(driver.currentZoneId!) ?? null;

    const result = await Promise.all(rides.map(async (ride) => {
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

      const farePesewas = requestFare(ride.type, ride.passengers, ride.riderId);
      const { driverShare } = splitFare(farePesewas);
      const pickupZoneName = zoneMap.get(ride.pickupZoneId)?.name ?? "";
      const dropoffZoneName = zoneMap.get(ride.dropoffZoneId)?.name ?? "";
      const trip = await offerDistances(prisma, ride, from, zoneMap, places);
      const stars = ratingOf.get(ride.riderId);

      return {
        rideId: ride.id,
        riderFirstName: firstName(ride.rider.name),
        pickupZoneName,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneName,
        dropoffZoneId: ride.dropoffZoneId,
        // Names, never coordinates, before the driver accepts.
        ...requestPlaceNames(ride, pickupZoneName, dropoffZoneName),
        type: ride.type as "LONE" | "SHARED",
        /** Riders on this request (a fresh request is its requester alone). */
        seats: ride.occupancy,
        farePesewas,
        driverSharePesewas: driverShare,
        createdAt: ride.createdAt.toISOString(),
        bestFit: myResult?.bestFit ?? false,
        // Ride offers: numbers and names only — no coordinates, no note.
        riderRating: stars != null ? Math.round(stars * 10) / 10 : null,
        ...trip,
        expiresAt: new Date((ride.broadcastStartedAt ?? ride.createdAt).getTime() + DISPATCH_WINDOW_MS).toISOString(),
        offerSeconds: config.driverOfferSeconds,
      };
    }));

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
  app.get("/rides/:id/fill-suggestions", { onRequest: requireAuth, schema: SCHEMAS.fillSuggestions }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const [anchor, allCandidates, adjacency, zones] = await Promise.all([
      prisma.ride.findUnique({
        where: { id: rideId },
        include: { passengers: { orderBy: { createdAt: "asc" } } },
      }),
      prisma.ride.findMany({
        // Not ones this driver declined or let time out: never offered twice.
        where: { status: "REQUESTED", driverId: null, type: "SHARED", rejections: { none: { driverUserId: userId } } },
        include: {
          rider: { select: { name: true } },
          passengers: { select: { riderId: true, status: true, lockedFare: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      getZoneAdjacency(prisma),
      getZoneMap(prisma),
    ]);
    if (!anchor || anchor.driverId !== userId) return rideNotFound(reply);
    if (anchor.type !== "SHARED") return reply.code(400).send({ error: "Ride is not SHARED" });
    if (!(FILLABLE_STATUSES as readonly string[]).includes(anchor.status)) {
      return reply.code(400).send({ error: "Riders can't be added to this trip now" });
    }

    // suggestFillsForRide's internal areCombinable filter is exactly what
    // makes this the "compatible, ranked" subset — left untouched.
    const compatibleRanked = suggestFillsForRide(
      anchor,
      // Demo riders only fill demo cars, real riders real cars.
      allCandidates.filter((candidate) => candidate.isReviewDemo === anchor.isReviewDemo),
      adjacency,
      new Date(),
    );
    const compatibleIds = new Set(compatibleRanked.map((r) => r.id));
    const byId = new Map(allCandidates.map((r) => [r.id, r]));
    const existingRiderIds = new Set(anchor.passengers.map((p) => p.riderId));
    const isFull = anchor.occupancy >= PRICING.MAX_SHARED_OCCUPANCY;

    const toSuggestion = (r: (typeof allCandidates)[number], compatible: boolean) => {
      const pickupZoneName = zones.get(r.pickupZoneId)?.name ?? "";
      const dropoffZoneName = zones.get(r.dropoffZoneId)?.name ?? "";
      return {
        requestRideId: r.id,
        riderFirstName: firstName(r.rider.name),
        pickupZoneName,
        pickupZoneId: r.pickupZoneId,
        dropoffZoneName,
        dropoffZoneId: r.dropoffZoneId,
        // Not this driver's rider yet: names only.
        ...requestPlaceNames(r, pickupZoneName, dropoffZoneName),
        createdAt: r.createdAt.toISOString(),
        compatible,
        /** What this rider was quoted, and pays if added (services/ride/fares). */
        farePesewas: requestFare("SHARED", r.passengers, r.riderId),
      };
    };

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
  app.get("/rides/:id/add-preview", { onRequest: requireAuth, schema: SCHEMAS.addPreview }, async (request, reply) => {
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
      prisma.ride.findUnique({
        where: { id: query.requestRideId },
        include: {
          rider: { select: { name: true } },
          passengers: { select: { riderId: true, status: true, lockedFare: true } },
        },
      }),
      getZoneMap(prisma),
      getStoredZoneRoutes(prisma),
    ]);

    if (!car || car.driverId !== userId) return rideNotFound(reply);
    if (car.type !== "SHARED" || !(FILLABLE_STATUSES as readonly string[]).includes(car.status)) {
      return refuse(reply, 409, "CAR_CLOSED", "Riders can't be added to this trip now.");
    }
    const seated = car.passengers.filter((p) => isActivePassengerStatus(p.status)).length;
    if (seated >= PRICING.MAX_SHARED_OCCUPANCY) return refuse(reply, 409, "CAR_FULL", "Your car is full.");
    if (
      !requestRide ||
      requestRide.isReviewDemo !== car.isReviewDemo ||
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

    // Only a request with pins needs the places (to approximate them); from memory once warm.
    const places = requestRide.pickupLat != null || requestRide.dropoffLat != null ? await getActivePlaces(prisma) : [];
    // The rider keeps the fare they were quoted (services/ride/fares).
    const farePesewas = requestFare("SHARED", requestRide.passengers, requestRide.riderId);
    const preview = previewAddRider({
      // The car's own riders: this driver's, so their exact pins.
      passengers: car.passengers.map((p) => ({
        id: p.id,
        riderName: p.rider.name,
        pickupZoneId: p.pickupZoneId,
        dropoffZoneId: p.dropoffZoneId,
        lockedFare: p.lockedFare,
        status: p.status as PassengerStatus,
        arrivedAt: p.arrivedAt?.toISOString() ?? null,
        ...pinFieldsOf(p),
      })),
      // The rider being considered isn't this driver's yet: the named place
      // their pin is at or near, never the pin itself (approximatePins).
      candidate: {
        requestRideId: requestRide.id,
        pickupZoneId: requestRide.pickupZoneId,
        dropoffZoneId: requestRide.dropoffZoneId,
        farePesewas,
        riderName: requestRide.rider.name,
        ...approximatePins(requestRide, zones, places),
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
      riderFirstName: firstName(requestRide.rider.name),
      pickupZoneName: zones.get(requestRide.pickupZoneId)?.name ?? "",
      dropoffZoneName: zones.get(requestRide.dropoffZoneId)?.name ?? "",
      ...requestPlaceNames(
        requestRide,
        zones.get(requestRide.pickupZoneId)?.name ?? "",
        zones.get(requestRide.dropoffZoneId)?.name ?? "",
      ),
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
        // The stop's point: a pin for the car's riders, the named place for
        // the new one (see above); the zone centre for rides without pins.
        label: st.label,
        latitude: st.point.latitude,
        longitude: st.point.longitude,
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
  app.post("/rides/:id/add-passenger", { onRequest: requireAuth, schema: SCHEMAS.addPassenger }, async (request, reply) => {
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
      const [zones, storedRoutes, places] = await Promise.all([
        getZoneMap(prisma),
        getStoredZoneRoutes(prisma),
        getActivePlaces(prisma),
      ]);
      // Worked out inside the transaction, with the car locked, so it is
      // exactly the car the rider joins.
      let onboardDelaySeconds: Record<string, number> = {};
      let requestPickupZoneId: string | null = null;
      let requestRiderId: string | null = null;
      const car = await addRiderToCar(prisma, userId, rideId, requestRideId, {
        checkCar: ({ passengers, candidate }) => {
          requestPickupZoneId = candidate.pickupZoneId;
          requestRiderId = candidate.riderId;
          // Built exactly as GET /add-preview builds it, so the add is
          // refused for the same reasons the preview showed.
          const preview = previewAddRider({
            passengers: passengers.map((p) => ({
              id: p.id,
              pickupZoneId: p.pickupZoneId,
              dropoffZoneId: p.dropoffZoneId,
              lockedFare: p.lockedFare,
              status: p.status as PassengerStatus,
              ...pinFieldsOf(p),
            })),
            candidate: {
              requestRideId,
              pickupZoneId: candidate.pickupZoneId,
              dropoffZoneId: candidate.dropoffZoneId,
              farePesewas: candidate.quotedFare,
              ...approximatePins(candidate, zones, places),
            },
            zones: [...zones.values()],
            routes: indexRoutes(storedRoutes),
            from,
          });
          if (preview && !preview.withinDetourLimit) throw new DetourTooLongError(preview.maxOnboardDelaySeconds);
          onboardDelaySeconds = preview?.onboardDelaySeconds ?? {};
        },
      });

      if (car.changed) {
        if (requestPickupZoneId)
          closeOffer(prisma, { id: requestRideId, pickupZoneId: requestPickupZoneId, driverId: userId }, "TAKEN");
        // #7 merged-rider reach: the absorbed request is now CANCELLED /
        // MERGED_INTO_ANOTHER_RIDE. That rider's app is still tracking it, so
        // tell its room — the client follows mergedIntoRideId to this car.
        emitRideEvent(requestRideId, "ride:status", { rideId: requestRideId, status: "CANCELLED" });
        if (requestRiderId) notifyRider(prisma, requestRiderId, "DRIVER_ASSIGNED", rideId, { driverUserId: userId });
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
      if (err instanceof NotRideOwnerError || (err instanceof RideNotFillableError && err.status === "MISSING")) {
        return rideNotFound(reply);
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
  app.post("/rides/:id/complete", { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.noBodyAction }, async (request, reply) => {
    if (!(await requireDriver(request, reply))) return;

    const { id: rideId } = request.params as { id: string };
    const userId = request.user!.userId;

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { passengers: true },
    });
    if (!ride || ride.driverId !== userId) return rideNotFound(reply);
    if (ride.type === "SHARED") {
      return reply
        .code(409)
        .send({ error: "SHARED rides complete automatically when the last passenger is dropped off" });
    }

    try {
      const updated = await applyRideTransition(prisma, rideId, "COMPLETED");
      emitRideEvent(rideId, "ride:status", { rideId, status: updated.status });
      notifyRider(prisma, updated.riderId, "TRIP_COMPLETED", rideId);

      await finalizeRideCompletion(prisma, updated, userId);

      // The driver's share of the fare this trip was booked at.
      const { driverShare } = splitFare(paidFareTotal(ride.type, ride.passengers));

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
    app.post(
      `/rides/:id/passengers/:passengerId/${action}`,
      { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.passengerAction },
      async (request, reply) => {
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
        // A seat on another driver's trip is answered exactly like a seat
        // that doesn't exist.
        if (err instanceof PassengerNotFoundError || err instanceof NotRideOwnerError) {
          return refuse(reply, 404, "PASSENGER_NOT_FOUND", "This rider is no longer on your trip.");
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
      announcePassengerChange(prisma, { passenger, ride, rideStatusBefore, driverUserId: userId, noShow: spec.noShow }).catch(
        (err) => request.log.error({ err, rideId, passengerId }, `passenger ${action}: follow-up failed`),
      );
      return reply;
    });
  }
}
