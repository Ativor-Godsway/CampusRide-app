import type { Prisma, PrismaClient, Ride, RidePassenger } from "@prisma/client";
import type { DriverCancelReason, PassengerStatus, RideStatus } from "@rida/shared";
import { seatsTaken } from "@rida/shared";
import { InvalidTransitionError, NotRideOwnerError, PassengerNotFoundError } from "./errors";
import { currentSeatFare } from "./fares";
import { isActivePassengerStatus } from "./stateMachine";
import { ACTIVE_RIDE_STATUSES } from "./activeRide";
import { CLEARED_WAIT } from "./waitFee";

/**
 * The three ways a pickup or a ride is cancelled by someone other than the
 * system: the rider (their own seat, wherever it lives), the driver ("Cancel
 * pickup": the rider searches again) and an admin (any seat or the whole
 * ride, any active status). The routes do the telling (sockets, pushes) after
 * these commit; see driverActionEvents.ts.
 */

export type RideWithSeats = Ride & { passengers: RidePassenger[] };

/** Seats a rider or a driver may cancel: before the pickup. */
export const PRE_PICKUP_SEAT_STATUSES: readonly PassengerStatus[] = ["WAITING", "ARRIVED"];

/** Same budget as every other seat action (rideService.ts). */
const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

/** A request closed because its rider was added to another driver's car. */
export function isMergedRequest(ride: Pick<Ride, "status" | "cancelReason" | "mergedIntoRideId">): boolean {
  return ride.status === "CANCELLED" && ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE" && ride.mergedIntoRideId !== null;
}

// ─── Rider ──────────────────────────────────────────────────────────────────

export type RiderCancelTarget =
  /** Their own request (ride.riderId): the route decides whole ride or seat. */
  | { kind: "own"; ride: RideWithSeats }
  /**
   * Their seat on a ride someone else booked: the car they were added to.
   * `ownRequestId` is their own (merged) request, where their cancel reason
   * is kept; null if it can't be found.
   */
  | { kind: "seat"; ride: RideWithSeats; seat: RidePassenger; ownRequestId: string | null };

/**
 * Which ride and seat a rider's POST /rides/:id/cancel is about. A rider
 * added to another driver's car ("fill the car") has two ids: their own
 * request (closed as MERGED_INTO_ANOTHER_RIDE) and the car's ride, where
 * their seat now lives. Current rider apps follow the merge and send the
 * car's id; a list or an older build may send their own. Both reach the
 * same seat.
 *
 * Null — answered 404, like a ride that doesn't exist — when the ride is
 * neither theirs nor one they have a seat on.
 */
export async function resolveRiderCancelTarget(
  prisma: PrismaClient,
  rideId: string,
  riderId: string,
): Promise<RiderCancelTarget | null> {
  const ride = await prisma.ride.findUnique({ where: { id: rideId }, include: { passengers: true } });
  if (!ride) return null;

  if (ride.riderId === riderId && isMergedRequest(ride)) {
    const car = await prisma.ride.findUnique({ where: { id: ride.mergedIntoRideId! }, include: { passengers: true } });
    const seat = car ? latestSeatOf(car, riderId) : null;
    // Nothing to follow (the car is gone): the request itself, which is closed.
    if (!car || !seat) return { kind: "own", ride };
    return { kind: "seat", ride: car, seat, ownRequestId: ride.id };
  }
  if (ride.riderId === riderId) return { kind: "own", ride };

  const seat = latestSeatOf(ride, riderId);
  if (!seat) return null;
  const ownRequest = await prisma.ride.findFirst({
    where: { riderId, mergedIntoRideId: ride.id },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  return { kind: "seat", ride, seat, ownRequestId: ownRequest?.id ?? null };
}

function latestSeatOf(ride: RideWithSeats, riderId: string): RidePassenger | null {
  const seats = ride.passengers.filter((p) => p.riderId === riderId);
  // A live seat first (a rider is only ever in a car once); else the newest.
  return seats.find((p) => isActivePassengerStatus(p.status)) ?? seats.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

// ─── Driver ─────────────────────────────────────────────────────────────────

export interface DriverCancelInput {
  rideId: string;
  passengerId: string;
  driverUserId: string;
  reason: DriverCancelReason | null;
  note: string | null;
  /**
   * A driver app build from before the reasons ("Remove rider"): it could
   * only cancel a rider still WAITING, and still can only do that.
   */
  legacy?: boolean;
  now?: Date;
}

export type DriverCancelResult =
  /** Already done (a retry), or the rider cancelled first: nothing written. */
  | { changed: false; passenger: RidePassenger; ride: RideWithSeats }
  /**
   * The rider was alone in the car on their own request: the same ride went
   * back to REQUESTED without a driver (a fresh 120 s search), their seat
   * back to WAITING. Apps already on phones simply see it searching again.
   */
  | { changed: true; mode: "requeued"; passenger: RidePassenger; ride: RideWithSeats; rideStatusBefore: RideStatus }
  /**
   * Others are in (or booked into) the car: this rider's seat is cancelled
   * there, the car carries on, and the rider gets a new request
   * (`rebookedRide`) with the same pickup, drop-off and fare.
   */
  | {
      changed: true;
      mode: "rebooked";
      passenger: RidePassenger;
      ride: RideWithSeats;
      rideStatusBefore: RideStatus;
      rebookedRide: Ride;
    };

/**
 * "Cancel pickup" by the assigned driver, before the rider is picked up
 * (WAITING or ARRIVED). The rider is never just dropped: their request goes
 * straight back to searching for another driver, which this driver is never
 * offered again. Recorded as a DriverCancellation (reason, note) — counted
 * as the driver's cancellation in admin, nothing more.
 *
 * Inside the same ride lock as every other seat action, so a pickup and a
 * cancel can't both land. Idempotent: a retry of a cancel that landed (the
 * seat may be WAITING on a ride that no longer has this driver) answers
 * `changed: false`, as does a seat the rider cancelled first.
 *
 * Throws PassengerNotFoundError (not on this ride), NotRideOwnerError (not
 * this driver's), InvalidTransitionError (picked up, dropped off — or
 * ARRIVED from a legacy build).
 */
export async function driverCancelPickup(prisma: PrismaClient, input: DriverCancelInput): Promise<DriverCancelResult> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    // One trip: lock the ride (found through the seat), and in the same
    // statement whether this driver already cancelled this seat (a retry) and
    // the rider's own request if they were added to this car (its source and
    // payment method go with them to their new request).
    const locked = await tx.$queryRaw<Array<Ride & { alreadyCancelled: boolean; ownRequest: Ride | null }>>`
      SELECT r.*,
        EXISTS (
          SELECT 1 FROM "DriverCancellation" dc
          WHERE dc."ridePassengerId" = ${input.passengerId} AND dc."driverUserId" = ${input.driverUserId}
        ) AS "alreadyCancelled",
        (
          SELECT row_to_json(o) FROM "Ride" o
          WHERE o."mergedIntoRideId" = r.id
            AND o."riderId" = (SELECT "riderId" FROM "RidePassenger" WHERE id = ${input.passengerId})
          ORDER BY o."createdAt" DESC LIMIT 1
        ) AS "ownRequest"
      FROM "Ride" r
      WHERE r.id = (SELECT "rideId" FROM "RidePassenger" WHERE id = ${input.passengerId})
      FOR UPDATE OF r`;
    const row = locked[0];
    if (!row || row.id !== input.rideId) throw new PassengerNotFoundError(input.passengerId);
    const { alreadyCancelled: done, ownRequest: mergedRequest, ...ride } = row;
    const passengers = await tx.ridePassenger.findMany({ where: { rideId: ride.id }, orderBy: { createdAt: "asc" } });
    const seat = passengers.find((p) => p.id === input.passengerId)!;

    if (done || seat.status === "CANCELLED") return { changed: false, passenger: seat, ride: { ...ride, passengers } };
    if (ride.driverId !== input.driverUserId) throw new NotRideOwnerError(ride.id, input.driverUserId);

    const allowed: readonly PassengerStatus[] = input.legacy ? ["WAITING"] : PRE_PICKUP_SEAT_STATUSES;
    if (!allowed.includes(seat.status as PassengerStatus)) {
      throw new InvalidTransitionError("RidePassenger", seat.status, "CANCELLED");
    }

    const rideStatusBefore = ride.status as RideStatus;
    const others = passengers.filter((p) => p.id !== seat.id && isActivePassengerStatus(p.status));
    const record = {
      ridePassengerId: seat.id,
      driverUserId: input.driverUserId,
      riderId: seat.riderId,
      reason: input.reason,
      note: input.note,
      createdAt: now,
    };

    // Alone in the car, on their own request, not yet moving: the ride itself searches again.
    const requeue =
      seat.riderId === ride.riderId && others.length === 0 && (ride.status === "MATCHED" || ride.status === "ARRIVED");
    if (requeue) {
      const updatedRide = await tx.ride.update({
        where: { id: ride.id },
        data: {
          status: "REQUESTED",
          driverId: null,
          broadcastStartedAt: now,
          decisionStartedAt: null,
          cancelReason: null,
          // The request asks for this booking's seats again.
          occupancy: seat.seats,
        },
      });
      // A fresh search, as for any return to REQUESTED — but never back to this driver.
      await tx.rideRejection.deleteMany({ where: { rideId: ride.id } });
      await tx.rideRejection.create({ data: { rideId: ride.id, driverUserId: input.driverUserId, reason: "DECLINED" } });
      const passenger = await tx.ridePassenger.update({
        where: { id: seat.id },
        data: { status: "WAITING", arrivedAt: null, ...CLEARED_WAIT },
      });
      await tx.driverCancellation.create({ data: { ...record, rideId: ride.id, rebookedRideId: null } });
      return {
        changed: true,
        mode: "requeued",
        passenger,
        ride: { ...updatedRide, passengers: passengers.map((p) => (p.id === seat.id ? passenger : p)) },
        rideStatusBefore,
      };
    }

    // Cancel the seat in this car (the car carries on for the others)…
    const passenger = await tx.ridePassenger.update({ where: { id: seat.id }, data: { status: "CANCELLED" } });
    // Seats left in the car (a booking for 2 takes 2).
    const rideData: Prisma.RideUpdateInput = { occupancy: seatsTaken(others) };
    if (others.length === 0) {
      if (ride.status === "IN_PROGRESS") Object.assign(rideData, { status: "COMPLETED", completedAt: now, cancelReason: null });
      else Object.assign(rideData, { status: "CANCELLED", cancelReason: "ALL_PASSENGERS_LEFT", cancelledAt: now });
    }
    const updatedRide = await tx.ride.update({ where: { id: ride.id }, data: rideData });

    // …and give the rider a new request with the same ends and fare.
    // (row_to_json gives the merged request's columns by name, enums as text.)
    const ownRequest: Pick<Ride, "type" | "source" | "paymentMethod"> | null =
      seat.riderId === ride.riderId ? ride : mergedRequest;
    const type = ownRequest?.type ?? ride.type;
    const pins = {
      pickupLat: seat.pickupLat,
      pickupLng: seat.pickupLng,
      pickupLabel: seat.pickupLabel,
      pickupPlaceId: seat.pickupPlaceId,
      dropoffLat: seat.dropoffLat,
      dropoffLng: seat.dropoffLng,
      dropoffLabel: seat.dropoffLabel,
      dropoffPlaceId: seat.dropoffPlaceId,
      pickupNote: seat.pickupNote,
    };
    const rebookedRide = await tx.ride.create({
      data: {
        riderId: seat.riderId,
        type,
        status: "REQUESTED",
        source: ownRequest?.source ?? "APP",
        paymentMethod: ownRequest?.paymentMethod ?? ride.paymentMethod,
        pickupZoneId: seat.pickupZoneId,
        dropoffZoneId: seat.dropoffZoneId,
        // The same booking: its seats (and its fare, below) go with it.
        occupancy: seat.seats,
        broadcastStartedAt: now,
        isReviewDemo: ride.isReviewDemo,
        ...pins,
        passengers: {
          create: {
            riderId: seat.riderId,
            pickupZoneId: seat.pickupZoneId,
            dropoffZoneId: seat.dropoffZoneId,
            status: "WAITING",
            lockedFare: seat.lockedFare ?? currentSeatFare(type),
            seats: seat.seats,
            ...pins,
          },
        },
        rejections: { create: { driverUserId: input.driverUserId, reason: "DECLINED" } },
      },
    });
    await tx.driverCancellation.create({ data: { ...record, rideId: ride.id, rebookedRideId: rebookedRide.id } });

    return {
      changed: true,
      mode: "rebooked",
      passenger,
      ride: { ...updatedRide, passengers: passengers.map((p) => (p.id === seat.id ? passenger : p)) },
      rideStatusBefore,
      rebookedRide,
    };
  }, TX_OPTIONS);
}

/**
 * Who cancelled a rider's seat, when it wasn't the rider, for GET /rides/:id:
 * their driver (with the new request their search moved to, which the rider
 * app follows) or an admin. Null for a rider's own cancel or a no-show.
 */
export async function seatCancelledBy(
  prisma: PrismaClient,
  rideId: string,
  seatId: string,
): Promise<{ seatCancelledBy: "driver" | "admin"; rebookedRideId: string | null } | null> {
  const [byDriver, byAdmin] = await Promise.all([
    prisma.driverCancellation.findFirst({
      where: { ridePassengerId: seatId },
      select: { rebookedRideId: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.adminAuditLog.findFirst({
      where: { target: rideId, OR: [{ action: "ride.cancel" }, { action: "ride.seat.cancel", reason: { startsWith: `Seat ${seatId}:` } }] },
      select: { id: true },
    }),
  ]);
  if (byAdmin) return { seatCancelledBy: "admin", rebookedRideId: null };
  if (byDriver) return { seatCancelledBy: "driver", rebookedRideId: byDriver.rebookedRideId };
  return null;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

/** Seat statuses an admin may cancel: anything not finished. */
const ADMIN_CANCELLABLE_SEATS: readonly PassengerStatus[] = ["WAITING", "ARRIVED", "PICKED_UP"];

export class AdminCancelRefusedError extends Error {
  constructor(
    readonly code: "RIDE_ENDED" | "SEAT_ENDED" | "SEAT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "AdminCancelRefusedError";
  }
}

export interface AdminCancelResult {
  /** False: the seat was already cancelled (a repeat); nothing written. */
  changed: boolean;
  ride: RideWithSeats;
  rideStatusBefore: RideStatus;
  /** The seats this call cancelled. */
  cancelledSeats: RidePassenger[];
}

/**
 * What a car becomes once nobody is left in or waiting for it: COMPLETED if
 * anyone was carried to their stop (their fares and the commission stand),
 * else CANCELLED by an admin. A ride already ended is left alone.
 */
function endIfEmpty(ride: Ride, seatsAfter: readonly RidePassenger[], now: Date): Prisma.RideUpdateInput {
  const data: Prisma.RideUpdateInput = {};
  if (!ACTIVE_RIDE_STATUSES.includes(ride.status as RideStatus)) return data;
  const remaining = seatsAfter.filter((p) => isActivePassengerStatus(p.status)).length;
  data.occupancy = seatsTaken(seatsAfter);
  if (remaining > 0) return data;
  if (seatsAfter.some((p) => p.status === "DROPPED_OFF")) {
    Object.assign(data, { status: "COMPLETED", completedAt: now, cancelReason: null });
  } else {
    Object.assign(data, { status: "CANCELLED", cancelReason: "ADMIN_CANCELLED", cancelledAt: now });
  }
  return data;
}

/**
 * An admin cancels one rider's seat, in any status but dropped off — also a
 * rider already in the car, and a seat on a ride whose driver vanished. The
 * car carries on for the others; if nobody is left it ends (endIfEmpty).
 * The rider is NOT re-booked: the admin decides. Audit-logged in the same
 * transaction ("ride.seat.cancel": who, when, the reason). Idempotent: a seat
 * already cancelled answers `changed: false`, and no second audit row.
 */
export async function adminCancelSeat(
  prisma: PrismaClient,
  input: { rideId: string; seatId: string; adminUserId: string; reason: string; now?: Date },
): Promise<AdminCancelResult> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const [ride] = await tx.$queryRaw<Ride[]>`SELECT * FROM "Ride" WHERE id = ${input.rideId} FOR UPDATE`;
    if (!ride) throw new AdminCancelRefusedError("SEAT_NOT_FOUND", "This seat isn't on this ride.");
    const passengers = await tx.ridePassenger.findMany({ where: { rideId: ride.id }, orderBy: { createdAt: "asc" } });
    const seat = passengers.find((p) => p.id === input.seatId);
    if (!seat) throw new AdminCancelRefusedError("SEAT_NOT_FOUND", "This seat isn't on this ride.");
    const rideStatusBefore = ride.status as RideStatus;
    if (seat.status === "CANCELLED") return { changed: false, ride: { ...ride, passengers }, rideStatusBefore, cancelledSeats: [] };
    if (!ADMIN_CANCELLABLE_SEATS.includes(seat.status as PassengerStatus)) {
      throw new AdminCancelRefusedError("SEAT_ENDED", "This rider has already been dropped off.");
    }

    const cancelled = await tx.ridePassenger.update({ where: { id: seat.id }, data: { status: "CANCELLED" } });
    const seatsAfter = passengers.map((p) => (p.id === seat.id ? cancelled : p));
    const data = endIfEmpty(ride, seatsAfter, now);
    const updatedRide = Object.keys(data).length > 0 ? await tx.ride.update({ where: { id: ride.id }, data }) : ride;
    await tx.adminAuditLog.create({
      data: { actor: input.adminUserId, action: "ride.seat.cancel", target: ride.id, reason: `Seat ${seat.id}: ${input.reason}`, timestamp: now },
    });
    return { changed: true, ride: { ...updatedRide, passengers: seatsAfter }, rideStatusBefore, cancelledSeats: [cancelled] };
  }, TX_OPTIONS);
}

/**
 * An admin cancels a whole ride in any active status — searching, a driver
 * on the way, on the trip, or stuck (a driver who vanished). Every seat not
 * yet finished is cancelled; the ride ends as endIfEmpty says (COMPLETED if
 * someone was already dropped off, else CANCELLED / ADMIN_CANCELLED).
 * Audit-logged in the same transaction ("ride.cancel"). A ride already
 * ended is refused (RIDE_ENDED), so a repeat never writes a second row.
 */
export async function adminCancelRide(
  prisma: PrismaClient,
  input: { rideId: string; adminUserId: string; reason: string; now?: Date },
): Promise<AdminCancelResult> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const [ride] = await tx.$queryRaw<Ride[]>`SELECT * FROM "Ride" WHERE id = ${input.rideId} FOR UPDATE`;
    if (!ride || !ACTIVE_RIDE_STATUSES.includes(ride.status as RideStatus)) {
      throw new AdminCancelRefusedError("RIDE_ENDED", "This ride has already ended.");
    }
    const passengers = await tx.ridePassenger.findMany({ where: { rideId: ride.id }, orderBy: { createdAt: "asc" } });
    const open = passengers.filter((p) => ADMIN_CANCELLABLE_SEATS.includes(p.status as PassengerStatus));
    if (open.length > 0) {
      await tx.ridePassenger.updateMany({ where: { id: { in: open.map((p) => p.id) } }, data: { status: "CANCELLED" } });
    }
    const openIds = new Set(open.map((p) => p.id));
    const seatsAfter = passengers.map((p) => (openIds.has(p.id) ? { ...p, status: "CANCELLED" as const } : p));
    const data = endIfEmpty(ride, seatsAfter, now);
    const updatedRide = await tx.ride.update({ where: { id: ride.id }, data });
    await tx.adminAuditLog.create({
      data: { actor: input.adminUserId, action: "ride.cancel", target: ride.id, reason: input.reason, timestamp: now },
    });
    return {
      changed: true,
      ride: { ...updatedRide, passengers: seatsAfter },
      rideStatusBefore: ride.status as RideStatus,
      cancelledSeats: seatsAfter.filter((p) => openIds.has(p.id)),
    };
  }, TX_OPTIONS);
}
