import type { PrismaClient, Ride } from "@prisma/client";
import { splitFare } from "@rida/shared";
import { searchWindowMs } from "./searchWindow";
import { requestFare } from "./fares";
import { emitDriverBroadcast, emitOfferClosed } from "../../realtime/rideSocket";
import { logger } from "../../lib/logger";
import type { OfferClosedReason } from "@rida/shared";
import { DriverHasActiveRideError, RideAlreadyClaimedError } from "./errors";
import { ACTIVE_DRIVER_STATUSES } from "./stateMachine";
import { requestPlaceNames } from "../../routes/ridePins";
import { notifyRideRequest } from "../push/notify";
import { dispatchDemoRide, isServedBySimDriver } from "../reviewDemo/simulation";
import { recordOffers, recordOffersClosed } from "../stats/rideOffers";
import { noteRequestClosed, noteRequestOffered } from "../admin/liveRequests";
import { emitBoardChanged, emitRequestsChanged } from "../../realtime/rideSocket";
import { carsThatFitRequest, liveFreeDrivers, requestsForDriver, type RequestRow } from "./requestFit";
import { scheduleRequestExpiry } from "./timeouts";
import type { AcceptedVia } from "./assembly";
import { getZoneMap } from "../zones/zoneCache";
import { liveDriverWhere } from "../zones/driverLiveness";
import type { SearchScope } from "@rida/shared";
import { forgetSearch, noteSearchDispatched, noteSearchOfferedTo } from "./searchProgress";
import { pushSearchStatus } from "./searchStatus";

/**
 * Returns the candidate set of drivers who could be dispatched a ride:
 * online + approved drivers whose app was heard from in the last 10 minutes
 * (services/zones/driverLiveness.ts), currently in the ride's pickup zone or
 * a zone adjacent to it (real neighbours since 2026-11-24, not every zone). This is the candidate set only — ranking/"perfect match"
 * ordering of these candidates is Phase 2c, not handled here.
 *
 * With the ride's `id` (ride offers, 2026-10), drivers who declined it are
 * left out: it is never offered to them again. A pop-up that only ran out
 * (TIMED_OUT) doesn't count (2026-11): the request stays in that driver's
 * list for the rest of its search. Drivers on a trip are still in this set;
 * driversOfferedTo is the one that applies the seat rules.
 */
export async function getEligibleDrivers(
  prisma: PrismaClient,
  ride: { id?: string; pickupZoneId: string; isReviewDemo?: boolean },
) {
  // Review demo (services/reviewDemo): a demo ride goes to demo drivers only,
  // wherever they are; a real ride never to a demo driver.
  if (ride.isReviewDemo) {
    return prisma.driver.findMany({
      where: {
        isOnline: true,
        isApproved: true,
        user: { isReviewDemo: true, ...(ride.id ? declinedNone(ride.id) : {}) },
      },
    });
  }

  // Edges to or from a retired zone don't count: eligibility never flows
  // through a zone that is out of service.
  const adjacencies = await prisma.zoneAdjacency.findMany({
    where: {
      OR: [{ zoneId: ride.pickupZoneId }, { adjacentZoneId: ride.pickupZoneId }],
      zone: { retiredAt: null },
      adjacentZone: { retiredAt: null },
    },
  });

  const zoneIds = new Set<string>([ride.pickupZoneId]);
  for (const adj of adjacencies) {
    zoneIds.add(adj.zoneId);
    zoneIds.add(adj.adjacentZoneId);
  }

  return prisma.driver.findMany({
    where: {
      // Online AND heard from in the last 10 minutes (services/zones/driverLiveness.ts).
      ...liveDriverWhere(),
      isApproved: true,
      currentZoneId: { in: Array.from(zoneIds) },
      currentZone: { retiredAt: null },
      user: { isReviewDemo: false, ...(ride.id ? declinedNone(ride.id) : {}) },
    },
  });
}

/** "Hasn't declined this ride" (requestFit.notDeclinedBy, from the driver's side). */
function declinedNone(rideId: string) {
  return { rideRejections: { none: { rideId, OR: [{ reason: null }, { reason: { not: "TIMED_OUT" } }] } } };
}

/**
 * The drivers a request is offered to now (shared-ride dispatch rules,
 * services/ride/requestFit): live drivers nearby with no trip — or, when
 * there are none, every live driver on campus with no trip (the fallback) —
 * and drivers whose Shared car it fits (free seats and the detour check). A
 * full car, a Ride alone car and an offline or stale driver are never in it.
 */
export async function driversOfferedTo(prisma: PrismaClient, ride: RequestRow): Promise<string[]> {
  return (await dispatchPlan(prisma, ride)).driverIds;
}

/**
 * driversOfferedTo, with what the rider's search screen says about it
 * (services/ride/searchStatus.ts): whether it went to drivers near the
 * pickup or, nobody free there, to every driver on campus; and how many
 * live drivers' cars were looked at — the nearby ones (free or on a trip),
 * the campus-wide free ones when it fell back, and the Shared cars checked
 * for a free seat and the detour.
 */
export interface DispatchPlan {
  driverIds: string[];
  scope: SearchScope;
  carsChecked: number;
}

export async function dispatchPlan(prisma: PrismaClient, ride: RequestRow): Promise<DispatchPlan> {
  const nearby = await getEligibleDrivers(prisma, ride);
  const considered = new Set(nearby.map((d) => d.userId));
  let scope: SearchScope = "nearby";
  const onTrip = nearby.length
    ? await prisma.ride.findMany({
        where: { driverId: { in: nearby.map((d) => d.userId) }, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
        select: { driverId: true },
      })
    : [];
  const busy = new Set(onTrip.map((r) => r.driverId));
  let free = nearby.filter((d) => !busy.has(d.userId)).map((d) => d.userId);
  // Fallback (2026-11-24): nobody live and free in the pickup zone or its
  // neighbours (or they all declined it) — every live free driver on campus
  // gets it, minus those who declined. Never for review demo rides.
  if (free.length === 0 && !ride.isReviewDemo) {
    const declined = ride.id
      ? new Set(
          (
            await prisma.rideRejection.findMany({
              where: { rideId: ride.id, OR: [{ reason: null }, { reason: { not: "TIMED_OUT" } }] },
              select: { driverUserId: true },
            })
          ).map((r) => r.driverUserId),
        )
      : new Set<string>();
    const campus = [...(await liveFreeDrivers(prisma)).keys()];
    for (const id of campus) considered.add(id);
    free = campus.filter((id) => !declined.has(id));
    scope = "campus";
  }
  const fitting = await carsThatFitRequest(prisma, ride, new Date(), considered);
  return { driverIds: [...new Set([...free, ...fitting])], scope, carsChecked: considered.size };
}

/**
 * A request stopped being available — another driver took it, the rider
 * cancelled, or its window ran out. Every online driver hears
 * `ride:offer_closed` and drops it from their offer queue and lists at
 * once, instead of on the next poll: the Home list, and the mid-trip list
 * of a Shared car, which isn't limited to nearby zones. Fire-and-forget:
 * never throws.
 */
export function closeOffer(
  prisma: PrismaClient,
  ride: { id: string; pickupZoneId: string; isReviewDemo?: boolean; driverId?: string | null },
  reason: OfferClosedReason,
): void {
  // The rider's search screen stops counting it.
  forgetSearch(ride.id);
  // Stats (services/stats/rideOffers.ts): the taker accepted, the rest closed with the reason.
  void recordOffersClosed(prisma, ride.id, reason, reason === "TAKEN" ? (ride.driverId ?? null) : null);
  // The admin live map stops showing it as waiting.
  noteRequestClosed(ride.id);
  void prisma.driver
    .findMany({
      where: { isOnline: true, isApproved: true, user: { isReviewDemo: ride.isReviewDemo ?? false } },
      select: { userId: true },
    })
    .then((drivers) => emitOfferClosed(drivers.map((d) => d.userId), { rideId: ride.id, reason }))
    .catch((err) => logger.warn("closeOffer failed", { rideId: ride.id, err }));
}

/**
 * Computes the eligible-driver set for a ride, builds the broadcast payload,
 * and emits ride:broadcast to each eligible driver's personal socket room.
 * Does not change ride state — call this after a ride enters (or re-enters)
 * REQUESTED.
 */
export async function broadcastRide(prisma: PrismaClient, rideId: string) {
  const ride = await prisma.ride.findUniqueOrThrow({
    where: { id: rideId },
    include: {
      pickupZone: true,
      dropoffZone: true,
      passengers: { select: { riderId: true, status: true, lockedFare: true } },
      rider: { select: { name: true } },
    },
  });
  // A review demo rider's request goes to the demo's simulated driver, never
  // to anyone else (services/reviewDemo).
  if (await isServedBySimDriver(prisma, ride)) {
    dispatchDemoRide(prisma, ride.id);
    return [];
  }
  // The search ends exactly when its window does, not at the next sweep.
  if (ride.status === "REQUESTED") scheduleRequestExpiry(prisma, ride.id, ride.broadcastStartedAt ?? ride.createdAt);
  const plan = await dispatchPlan(prisma, ride);
  const eligible = plan.driverIds.map((userId) => ({ userId }));
  // The rider's search screen: who has it, how far it went, what was checked.
  if (ride.status === "REQUESTED") {
    noteSearchDispatched(ride.id, (ride.broadcastStartedAt ?? ride.createdAt).getTime(), plan);
    pushSearchStatus(prisma, ride.id);
  }
  // The admin live map's "waiting for a driver" (memory only), offered or not.
  if (!ride.isReviewDemo) {
    noteRequestOffered(
      {
        rideId: ride.id,
        riderId: ride.riderId,
        riderName: ride.rider.name,
        type: ride.type,
        requestedAt: ride.createdAt.getTime(),
        pickup:
          ride.pickupLat != null && ride.pickupLng != null
            ? { latitude: ride.pickupLat, longitude: ride.pickupLng, label: ride.pickupLabel ?? ride.pickupZone.name }
            : { latitude: ride.pickupZone.latitude, longitude: ride.pickupZone.longitude, label: ride.pickupZone.name },
        pickupZoneId: ride.pickupZoneId,
        pickupLabel: ride.pickupLabel ?? ride.pickupZone.name,
        dropoffLabel: ride.dropoffLabel ?? ride.dropoffZone.name,
      },
      eligible.map((d) => d.userId),
    );
  }

  // The request board (every online driver's, wherever they are) refetches.
  void prisma.driver
    .findMany({ where: { ...liveDriverWhere(), isApproved: true, user: { isReviewDemo: ride.isReviewDemo ?? false } }, select: { userId: true } })
    .then((drivers) => emitBoardChanged(drivers.map((d) => d.userId)))
    .catch((err) => logger.warn("board refresh failed", { rideId: ride.id, err }));

  if (eligible.length > 0) {
    const payload = broadcastPayload(ride, ride.pickupZone.name, ride.dropoffZone.name);
    emitDriverBroadcast(
      eligible.map((d) => d.userId),
      payload,
    );
    // Drivers whose app is in the background or closed get it as a push.
    notifyRideRequest(prisma, ride.id, eligible.map((d) => d.userId), payload.pickupPlaceName!);
    // Stats: who it was offered to, and when (services/stats/rideOffers.ts).
    void recordOffers(prisma, ride.id, eligible.map((d) => d.userId));
  }

  return eligible;
}

/** The ride:broadcast payload: names and money, never a rider's coordinates. */
function broadcastPayload(ride: RequestRow, pickupZoneName: string, dropoffZoneName: string) {
  // The fare the rider was quoted, stored on their seat (services/ride/fares).
  const farePesewas = requestFare(ride.type, ride.passengers, ride.riderId);
  const { driverShare } = splitFare(farePesewas);
  return {
    rideId: ride.id,
    pickupZoneName,
    dropoffZoneName,
    ...requestPlaceNames(ride, pickupZoneName, dropoffZoneName),
    type: ride.type,
    // Seats this booking takes (Shared) or people in it (Ride alone): one fare for all.
    seats: ride.occupancy,
    farePesewas,
    driverSharePesewas: driverShare,
    expiresAt: (ride.broadcastStartedAt?.getTime() ?? Date.now()) + searchWindowMs(),
  };
}

/**
 * A seat in this driver's car changed — a drop-off, a cancel or no-show, an
 * undo, a rider added, the trip ending. Their lists are worked out again
 * at once: `driver:requests_changed` makes the app refetch, and every open
 * request that fits now is sent as `ride:broadcast` (which app builds from
 * before this event also refetch on), including requests that started
 * searching while the car was full. No push: the driver is in the app.
 * Fire-and-forget: never throws.
 */
export function reofferToDriver(prisma: PrismaClient, driverUserId: string | null | undefined): void {
  if (!driverUserId) return;
  emitRequestsChanged(driverUserId);
  void Promise.all([requestsForDriver(prisma, driverUserId), getZoneMap(prisma)])
    .then(([rides, zones]) => {
      for (const ride of rides) {
        // The rider's search screen counts this driver too.
        noteSearchOfferedTo(ride.id, (ride.broadcastStartedAt ?? ride.createdAt).getTime(), driverUserId);
        pushSearchStatus(prisma, ride.id);
        emitDriverBroadcast(
          [driverUserId],
          broadcastPayload(ride, zones.get(ride.pickupZoneId)?.name ?? "", zones.get(ride.dropoffZoneId)?.name ?? ""),
        );
      }
    })
    .catch((err) => logger.warn("reofferToDriver failed", { driverUserId, err }));
}

/**
 * Atomically claims a REQUESTED ride for a driver.
 *
 * Implemented as a single conditional UPDATE:
 *   UPDATE Ride SET driverId = :driverId, status = 'MATCHED'
 *   WHERE id = :rideId AND status = 'REQUESTED' AND driverId IS NULL
 *
 * Exactly one of N concurrent callers will affect a row (count === 1) and
 * win the claim — the rest affect zero rows and throw
 * RideAlreadyClaimedError. The win/lose decision is made by Postgres's
 * row-level locking on the conditional update itself, not by an
 * application-level read-then-write or lock. This deliberately stays a
 * single round-trip statement, no held-open transaction — an earlier version
 * wrapped this in prisma.$transaction to make the driver-active-ride check
 * below airtight, but that held a connection per concurrent caller and blew
 * past Neon's pooled connection_limit under this project's own concurrent-
 * claim test, turning clean RideAlreadyClaimedError rejections into raw
 * PrismaClientKnownRequestErrors. Not worth it for a check that's already
 * accepted as a small, non-atomic race on the rider side (see
 * ActiveRideExistsError in createRide.ts) — this mirrors that exactly.
 *
 * Before the update, checks the claiming driver doesn't already hold an
 * active ride (MATCHED/ARRIVED/IN_PROGRESS) via a plain pre-check read, the
 * same read-then-write shape createRide.ts uses for the rider-side guard.
 *
 * This blocks the common case — a driver claiming a second ride while
 * already on one. It does NOT close the rare race where the same driver
 * fires two concurrent claims (for two different REQUESTED rides) at almost
 * the same instant: both pre-check reads can pass before either update
 * commits, since the read and the write aren't in the same transaction.
 * Full atomicity for this check is tracked for post-buildathon.
 */
export async function claimRide(prisma: PrismaClient, rideId: string, driverId: string) {
  const existingActiveRide = await prisma.ride.findFirst({
    where: { driverId, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
  });
  if (existingActiveRide) {
    throw new DriverHasActiveRideError(existingActiveRide);
  }

  const claimed = await claimIfOpen(prisma, rideId, driverId);
  if (!claimed) throw new RideAlreadyClaimedError(rideId);
  return claimed;
}

/**
 * The claim itself: one conditional UPDATE that also returns the claimed row
 * (it used to be an update and then a second query to read the row back).
 * Null when the ride was not open: already claimed, cancelled or timed out.
 */
export async function claimIfOpen(
  prisma: PrismaClient,
  rideId: string,
  driverId: string,
  /** Where the driver took it from (Ride.acceptedVia), kept in the same statement. */
  acceptedVia: AcceptedVia | null = null,
): Promise<Ride | null> {
  // A review demo ride can only be taken by a demo driver, and a real ride
  // only by a real one (services/reviewDemo): checked in the same statement.
  const rows = await prisma.$queryRaw<Ride[]>`
    UPDATE "Ride" SET "driverId" = ${driverId}, status = 'MATCHED', "matchedAt" = COALESCE("matchedAt", now()),
      "acceptedVia" = ${acceptedVia}
    WHERE id = ${rideId} AND status = 'REQUESTED' AND "driverId" IS NULL
      AND "isReviewDemo" = (SELECT u."isReviewDemo" FROM "User" u WHERE u.id = ${driverId})
    RETURNING *`;
  return rows[0] ?? null;
}
