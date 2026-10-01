import type { PrismaClient, Prisma, Ride, RidePassenger } from "@prisma/client";
import {
  NO_SHOW_AFTER_MS,
  getSharedFarePerRider,
  validateSharedOccupancy,
} from "@rida/shared";
import type { PassengerStatus, RideStatus } from "@rida/shared";
import {
  isActivePassengerStatus,
  transitionPassenger,
  transitionRide,
  type RideTransitionContext,
} from "./stateMachine";
import { recomputeLockedFares, type LockedFarePassenger } from "./lockedFare";
import { InvalidTransitionError, NoShowTooEarlyError, NotRideOwnerError, PassengerNotFoundError } from "./errors";

export type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Neon's pooled connection has noticeable per-query latency, and these
 * transactions issue several sequential queries — raise the interactive
 * transaction timeout above Prisma's 5s default to avoid spurious P2028s.
 * maxWait (how long to wait for a pooled connection before the transaction
 * may start) is raised from Prisma's 2 s for the same reason: under a busy
 * pool, "Unable to start a transaction in the given time" was a 500 for a
 * perfectly valid status change.
 */
const TX_OPTIONS = { timeout: 20000, maxWait: 10_000 } as const;

/**
 * Validates and applies a Ride status transition inside a transaction.
 * Throws InvalidTransitionError for illegal moves (no DB writes occur).
 *
 * Side effects beyond status/cancelReason:
 * - MATCHED -> REQUESTED (driver backout): clears driverId, preserves passengers.
 * - ARRIVED -> IN_PROGRESS (departure): stamps departedAt; lockedFares freeze
 *   permanently from this point (no further recompute calls are made).
 * - IN_PROGRESS -> COMPLETED: stamps completedAt.
 * - * -> REQUESTED: stamps broadcastStartedAt = now, clears decisionStartedAt
 *   and discards any driver rejections (a fresh broadcast/dispatch window
 *   starts, so drivers who declined the previous offer are offered it again).
 * - * -> AWAITING_RIDER_DECISION: stamps decisionStartedAt = now (the 90s
 *   grace period for the rider's decision starts).
 *
 * `now` is injectable so timeout-related transitions can be driven by tests
 * without depending on wall-clock time.
 */
export async function applyRideTransition(
  prisma: PrismaClient,
  rideId: string,
  toStatus: RideStatus,
  ctx: RideTransitionContext = {},
  now: Date = new Date(),
) {
  return prisma.$transaction((tx) => transitionRideTx(tx, rideId, toStatus, ctx, now), TX_OPTIONS);
}

/**
 * Core of `applyRideTransition`, factored out so it can be composed inside a
 * larger transaction (Phase 6b-3: `applyPassengerTransition` walks the ride
 * forward on first-pickup/last-dropoff without opening a second, nested
 * transaction — `tx` here is already an open transaction client).
 */
async function transitionRideTx(
  tx: Tx,
  rideId: string,
  toStatus: RideStatus,
  ctx: RideTransitionContext = {},
  now: Date = new Date(),
) {
  const ride = await tx.ride.findUniqueOrThrow({ where: { id: rideId } });
  const result = transitionRide(ride, toStatus, ctx);

  const data: Prisma.RideUpdateInput = {
    status: result.status,
    cancelReason: result.cancelReason,
  };

  if (ride.status === "MATCHED" && toStatus === "REQUESTED" && ride.driverId) {
    data.driver = { disconnect: true };
  }
  if (toStatus === "IN_PROGRESS") {
    data.departedAt = new Date();
  }
  if (toStatus === "COMPLETED") {
    data.completedAt = new Date();
  }
  if (toStatus === "CANCELLED" && ctx.riderCancel) {
    // Same write as the status change, so a cancel can never be recorded
    // without the reason the rider gave for it.
    data.riderCancelReason = ctx.riderCancel.reason;
    data.riderCancelNote = ctx.riderCancel.note;
  }
  if (toStatus === "REQUESTED") {
    data.broadcastStartedAt = now;
    data.decisionStartedAt = null;
    // Phase 4: a fresh broadcast window is a fresh offer, so previous
    // declines are discarded and every eligible driver — including the ones
    // who passed last time — sees it again. A rejection says "not this
    // offer", not "never this ride"; the driver's circumstances (location,
    // whether they already have a fare) have very likely changed by the time
    // a ride comes back around.
    await tx.rideRejection.deleteMany({ where: { rideId } });
  }
  if (toStatus === "AWAITING_RIDER_DECISION") {
    data.decisionStartedAt = now;
  }

  return tx.ride.update({ where: { id: rideId }, data });
}

export interface PassengerTransitionResult {
  passenger: RidePassenger;
  /** The ride after the transition, with ALL its passengers — built from the
   * rows this call already read and wrote, never re-fetched. */
  ride: Ride & { passengers: RidePassenger[] };
  /**
   * False when the passenger was already in the requested status: nothing was
   * written and the caller should skip its side effects (socket events, SMS,
   * payment finalisation). Makes every driver action safe to retry — the app
   * retries after a timeout, and the first attempt may well have landed.
   */
  changed: boolean;
  /** The ride's status before this call, so callers can tell what moved. */
  rideStatusBefore: RideStatus;
}

export interface PassengerTransitionOptions {
  /**
   * The statuses this action may start from (e.g. a driver may cancel a
   * seat only while WAITING). Anything else is an InvalidTransitionError,
   * even where the state machine itself would allow it.
   */
  onlyFrom?: readonly PassengerStatus[];
  /** The ride id from the URL; a passenger on another ride is "not found". */
  expectedRideId?: string;
  /** The acting driver; any other driver gets NotRideOwnerError. */
  expectedDriverId?: string;
  /** Cancel as "rider didn't show": only from ARRIVED, and only NO_SHOW_AFTER_MS after arrival. */
  noShow?: boolean;
}

/**
 * Validates and applies a RidePassenger status transition inside a transaction.
 *
 * Round trips matter here (every query is a trip to the database, one after
 * another), so the whole thing is: lock the ride (one query that also finds
 * it from the passenger), read its passengers, write the passenger, and write
 * the ride if it moves. The result is assembled from those rows. See
 * routes/driverRoundTrips.test.ts for the budget this is held to.
 *
 * Side effects, all decided from the passenger list read AFTER the lock (so
 * two concurrent taps on the same car serialize and never both think they
 * were "last"):
 *
 * - WAITING -> ARRIVED: stamps arrivedAt (the rider's wait timer). If the ride
 *   is still MATCHED it moves to ARRIVED too, so a Ride-alone rider's app,
 *   which reads the ride status, says "your driver has arrived".
 * - ARRIVED -> PICKED_UP: the ride's first pickup walks it to IN_PROGRESS
 *   (through ARRIVED if needed — RIDE_TRANSITIONS is checked for each hop).
 * - PICKED_UP -> DROPPED_OFF: stamps fareCharged from lockedFare; the last
 *   active passenger's drop-off completes the ride.
 * - -> CANCELLED: recomputes occupancy. If nobody is left in the car, the
 *   ride ends: COMPLETED if it is under way (someone was carried — a ride
 *   past the point of no return can only complete), otherwise CANCELLED
 *   (ALL_PASSENGERS_LEFT). It used to always try CANCELLED, which the state
 *   machine refuses for an IN_PROGRESS ride — cancelling the last waiting
 *   rider after the others were dropped off failed and left the ride stuck.
 *
 * Idempotent: asking for the status the passenger already has returns the
 * current state with `changed: false` and writes nothing.
 *
 * Per-rider fare summaries and the CASH commission ledger are NOT done here —
 * the caller does that after commit when `ride.status` became COMPLETED.
 */
export async function applyPassengerTransition(
  prisma: PrismaClient,
  passengerId: string,
  toStatus: PassengerStatus,
  now: Date = new Date(),
  options: PassengerTransitionOptions = {},
): Promise<PassengerTransitionResult> {
  return prisma.$transaction(async (tx) => {
    // Lock the ride row, found through the passenger, in one round trip.
    // Locking before reading siblings is what serializes concurrent actions
    // on the same car.
    const locked = await tx.$queryRaw<Ride[]>`
      SELECT r.* FROM "Ride" r
      WHERE r.id = (SELECT "rideId" FROM "RidePassenger" WHERE id = ${passengerId})
      FOR UPDATE`;
    const ride = locked[0];
    if (!ride || (options.expectedRideId && ride.id !== options.expectedRideId)) {
      throw new PassengerNotFoundError(passengerId);
    }
    if (options.expectedDriverId && ride.driverId !== options.expectedDriverId) {
      throw new NotRideOwnerError(ride.id, options.expectedDriverId);
    }

    const passengers = await tx.ridePassenger.findMany({
      where: { rideId: ride.id },
      orderBy: { createdAt: "asc" },
    });
    const passenger = passengers.find((p) => p.id === passengerId)!;

    const rideStatusBefore = ride.status as RideStatus;
    if (passenger.status === toStatus) {
      return { passenger, ride: { ...ride, passengers }, changed: false, rideStatusBefore };
    }
    if (options.onlyFrom && !options.onlyFrom.includes(passenger.status as PassengerStatus)) {
      throw new InvalidTransitionError("RidePassenger", passenger.status, toStatus);
    }
    transitionPassenger(passenger, toStatus);

    if (options.noShow) {
      const availableAt = passenger.arrivedAt
        ? new Date(passenger.arrivedAt.getTime() + NO_SHOW_AFTER_MS)
        : null;
      if (passenger.status !== "ARRIVED" || !availableAt || availableAt > now) {
        throw new NoShowTooEarlyError(availableAt);
      }
    }

    const updatedPassenger = await tx.ridePassenger.update({
      where: { id: passengerId },
      data: {
        status: toStatus,
        ...(toStatus === "ARRIVED" ? { arrivedAt: now } : {}),
        ...(toStatus === "DROPPED_OFF" ? { fareCharged: passenger.lockedFare } : {}),
        ...(options.noShow ? { noShowAt: now } : {}),
      },
    });
    const allPassengers = passengers.map((p) => (p.id === passengerId ? updatedPassenger : p));
    const others = passengers.filter((p) => p.id !== passengerId);

    // Work out where the ride goes, checking every hop against the ride
    // state machine, then write it once.
    const rideData: Prisma.RideUpdateInput = {};
    let status = ride.status as RideStatus;
    const hop = (to: RideStatus, ctx: RideTransitionContext = {}) => {
      const result = transitionRide({ status }, to, ctx);
      status = result.status;
      rideData.status = result.status;
      rideData.cancelReason = result.cancelReason;
      if (to === "IN_PROGRESS") rideData.departedAt = now;
      if (to === "COMPLETED") rideData.completedAt = now;
    };

    if (toStatus === "ARRIVED" && status === "MATCHED") hop("ARRIVED");

    if (toStatus === "PICKED_UP" && status !== "IN_PROGRESS") {
      const someoneAlreadyMoving = others.some((p) => p.status === "PICKED_UP" || p.status === "DROPPED_OFF");
      if (!someoneAlreadyMoving) {
        if (status === "MATCHED") hop("ARRIVED");
        hop("IN_PROGRESS");
      }
    }

    if (toStatus === "DROPPED_OFF" && !others.some((p) => isActivePassengerStatus(p.status))) {
      hop("COMPLETED");
    }

    if (toStatus === "CANCELLED") {
      const remaining = others.filter((p) => isActivePassengerStatus(p.status)).length;
      rideData.occupancy = remaining;
      if (remaining === 0) {
        if (status === "IN_PROGRESS") hop("COMPLETED");
        else hop("CANCELLED", { cancelReason: "ALL_PASSENGERS_LEFT" });
      }
    }

    const finalRide =
      Object.keys(rideData).length > 0 ? await tx.ride.update({ where: { id: ride.id }, data: rideData }) : ride;

    return {
      passenger: updatedPassenger,
      ride: { ...finalRide, passengers: allPassengers },
      changed: true,
      rideStatusBefore,
    };
  }, PASSENGER_TX_OPTIONS);
}

/**
 * A driver action waits up to maxWait for a pooled connection before its
 * transaction may start. Prisma's 2 s default turned a busy pool into
 * "Unable to start a transaction in the given time" — a 500 the app showed
 * as "reverted" although nothing was wrong with the action itself.
 */
const PASSENGER_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

export interface JoinSharedRideInput {
  riderId: string;
  pickupZoneId: string;
  dropoffZoneId: string;
}

/**
 * Adds a new passenger to a SHARED ride and re-locks fares for everyone
 * currently active, using the downward-only ratchet from recomputeLockedFares.
 * Throws if the resulting occupancy would exceed 4 (validateSharedOccupancy).
 *
 * Core logic lives in `joinSharedRideTx` so it can be composed inside a
 * larger transaction (e.g. addRiderToCar in Phase 2d); this wrapper opens
 * its own transaction for standalone callers.
 */
export async function joinSharedRide(
  prisma: PrismaClient,
  rideId: string,
  input: JoinSharedRideInput,
) {
  return prisma.$transaction((tx) => joinSharedRideTx(tx, rideId, input), TX_OPTIONS);
}

export async function joinSharedRideTx(tx: Tx, rideId: string, input: JoinSharedRideInput) {
  const ride = await tx.ride.findUniqueOrThrow({
    where: { id: rideId },
    include: { passengers: true },
  });
  const { passengers, ...rideFields } = ride;
  return joinLoadedSharedRideTx(tx, rideFields, passengers, input);
}

/**
 * The body of joinSharedRideTx for a caller that has already read (and
 * ideally locked) the ride and its passengers — addRiderToCar — so the join
 * doesn't read them a second time.
 */
export async function joinLoadedSharedRideTx(
  tx: Tx,
  ride: Ride,
  passengers: readonly RidePassenger[],
  input: JoinSharedRideInput,
  options: {
    /**
     * After departure fares are frozen: leave every existing rider's locked
     * fare exactly as it is (no ratchet) and give the newcomer the flat rate.
     */
    freezeExistingFares?: boolean;
  } = {},
) {
  const rideId = ride.id;
  if (ride.type !== "SHARED") {
    throw new Error("joinSharedRide: ride is not a SHARED ride");
  }

  const activePassengers = passengers.filter((p) =>
    isActivePassengerStatus(p.status),
  );
  const newOccupancy = activePassengers.length + 1;
  validateSharedOccupancy(newOccupancy);

  const newRate = getSharedFarePerRider(newOccupancy);

  const passengersForRecompute: LockedFarePassenger[] = [
    ...activePassengers.map((p) => ({
      id: p.id,
      status: p.status,
      lockedFare: p.lockedFare ?? newRate,
    })),
    { id: "__new__", status: "WAITING" as const, lockedFare: newRate },
  ];

  const recomputed = options.freezeExistingFares
    ? passengersForRecompute
    : recomputeLockedFares(passengersForRecompute, { type: "JOIN" });

  const refared = new Map<string, number>();
  for (const p of recomputed) {
    if (p.id === "__new__") continue;
    const original = activePassengers.find((a) => a.id === p.id);
    if (original && original.lockedFare !== p.lockedFare) {
      await tx.ridePassenger.update({
        where: { id: p.id },
        data: { lockedFare: p.lockedFare },
      });
      refared.set(p.id, p.lockedFare);
    }
  }

  const newPassengerLockedFare =
    recomputed.find((p) => p.id === "__new__")?.lockedFare ?? newRate;

  const newPassenger = await tx.ridePassenger.create({
    data: {
      rideId,
      riderId: input.riderId,
      pickupZoneId: input.pickupZoneId,
      dropoffZoneId: input.dropoffZoneId,
      status: "WAITING",
      lockedFare: newPassengerLockedFare,
    },
  });

  const updatedRide = await tx.ride.update({
    where: { id: rideId },
    data: { occupancy: newOccupancy },
  });

  return {
    passenger: newPassenger,
    ride: updatedRide,
    /** Every passenger on the ride afterwards, the new one last. */
    passengers: [
      ...passengers.map((p) => (refared.has(p.id) ? { ...p, lockedFare: refared.get(p.id)! } : p)),
      newPassenger,
    ],
  };
}
