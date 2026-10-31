import type { PrismaClient, RideCancelReason, RideStatus } from "@prisma/client";
import { splitFare } from "@rida/shared";
import { paidFareTotal } from "../ride/fares";
import type { OnlineSession } from "./metrics";
import type { Period } from "./period";

/**
 * What the dashboard's aggregates are computed from: the rows of ONE period,
 * each with only the columns a definition needs (docs/admin-metrics.md). One
 * query per kind of row, never one per ride or driver. Review demo rides and
 * accounts are left out everywhere.
 */

export interface RequestFact {
  id: string;
  riderId: string;
  driverId: string | null;
  type: "LONE" | "SHARED";
  status: RideStatus;
  pickupZoneId: string;
  dropoffZoneId: string;
  createdAt: Date;
  matchedAt: Date | null;
  cancelledAt: Date | null;
  noDriverFoundAt: Date | null;
  cancelReason: RideCancelReason | null;
  riderCancelReason: string | null;
  mergedIntoRideId: string | null;
}

/** Ride requests made in the period (Ride.createdAt), every kind. */
export function loadRequests(prisma: PrismaClient, period: Period, where: { pickupZoneId?: string } = {}): Promise<RequestFact[]> {
  return prisma.ride.findMany({
    where: { createdAt: { gte: period.from, lt: period.to }, isReviewDemo: false, ...where },
    select: {
      id: true,
      riderId: true,
      driverId: true,
      type: true,
      status: true,
      pickupZoneId: true,
      dropoffZoneId: true,
      createdAt: true,
      matchedAt: true,
      cancelledAt: true,
      noDriverFoundAt: true,
      cancelReason: true,
      riderCancelReason: true,
      mergedIntoRideId: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * "Got a driver": a driver took it (matchedAt), or added the rider to their
 * car (the request was merged into that car's ride).
 */
export function gotDriver(r: Pick<RequestFact, "matchedAt" | "cancelReason">): boolean {
  return r.matchedAt !== null || r.cancelReason === "MERGED_INTO_ANOTHER_RIDE";
}

/** When it got its driver: matched, or merged into a car (its cancelledAt). */
export function gotDriverAt(r: Pick<RequestFact, "matchedAt" | "cancelReason" | "cancelledAt">): Date | null {
  if (r.matchedAt) return r.matchedAt;
  if (r.cancelReason === "MERGED_INTO_ANOTHER_RIDE") return r.cancelledAt;
  return null;
}

/**
 * "No driver found": its offer window ran out with nobody taking it
 * (noDriverFoundAt; for rides from before that column, the status or
 * cancel reason that means the same) — even if a driver came later.
 */
export function noDriverFound(r: Pick<RequestFact, "noDriverFoundAt" | "cancelReason" | "status" | "matchedAt">): boolean {
  return (
    r.noDriverFoundAt !== null ||
    r.cancelReason === "NO_DRIVERS_AVAILABLE" ||
    (r.status === "AWAITING_RIDER_DECISION" && r.matchedAt === null)
  );
}

export type CancelledBy = "rider" | "driver" | "system";

/**
 * Who cancelled a cancelled request, or null when it wasn't a cancellation
 * (completed, still going, or merged into a car — that is getting a driver).
 */
export function cancelledBy(r: Pick<RequestFact, "status" | "cancelReason">): CancelledBy | null {
  if (r.status !== "CANCELLED") return null;
  switch (r.cancelReason) {
    case "MERGED_INTO_ANOTHER_RIDE":
      return null;
    case "DRIVER_BACKED_OUT":
      return "driver";
    case "NO_DRIVERS_AVAILABLE":
      return "system";
    case "RIDER_CANCELLED":
    case "ALL_PASSENGERS_LEFT":
    default:
      return "rider";
  }
}

export interface CompletedTrip {
  id: string;
  driverId: string | null;
  type: "LONE" | "SHARED";
  createdAt: Date;
  completedAt: Date;
  pickupZoneId: string;
  /** Σ the stored fares of the seats the ride was paid for (pesewas). */
  farePesewas: number;
  /** CampusRide's 15%: the stored CommissionLedger amount (or 15% of the fare when there is no ledger row). */
  commissionPesewas: number;
  seats: number;
}

/** Trips completed in the period (Ride.completedAt), with their stored fares and commission. */
export async function loadCompletedTrips(
  prisma: PrismaClient,
  period: Period,
  where: { driverId?: string } = {},
): Promise<CompletedTrip[]> {
  const rows = await prisma.ride.findMany({
    where: { status: "COMPLETED", completedAt: { gte: period.from, lt: period.to }, isReviewDemo: false, ...where },
    select: {
      id: true,
      driverId: true,
      type: true,
      createdAt: true,
      completedAt: true,
      pickupZoneId: true,
      passengers: { select: { status: true, lockedFare: true, fareCharged: true } },
      commissionLedger: { select: { amountPesewas: true } },
    },
    orderBy: { completedAt: "asc" },
  });
  return rows.map((r) => {
    const fare = paidFareTotal(r.type, r.passengers);
    return {
      id: r.id,
      driverId: r.driverId,
      type: r.type,
      createdAt: r.createdAt,
      completedAt: r.completedAt!,
      pickupZoneId: r.pickupZoneId,
      farePesewas: fare,
      commissionPesewas: r.commissionLedger?.amountPesewas ?? splitFare(fare).commission,
      seats: r.type === "LONE" ? 1 : r.passengers.filter((p) => p.status === "DROPPED_OFF").length,
    };
  });
}

/** Online sessions that overlap the period (an open one counts up to now). */
export function loadSessions(prisma: PrismaClient, period: Period, where: { driverUserId?: string } = {}): Promise<OnlineSession[]> {
  return prisma.driverOnlineSession.findMany({
    where: {
      startedAt: { lt: period.to },
      OR: [{ endedAt: null }, { endedAt: { gt: period.from } }],
      driver: { isReviewDemo: false },
      ...where,
    },
    select: { driverUserId: true, startedAt: true, endedAt: true },
  });
}

/** Zone names by id (retired zones too: old rides use them). */
export async function zoneNames(prisma: PrismaClient): Promise<Map<string, string>> {
  const zones = await prisma.zone.findMany({ select: { id: true, name: true } });
  return new Map(zones.map((z) => [z.id, z.name]));
}
