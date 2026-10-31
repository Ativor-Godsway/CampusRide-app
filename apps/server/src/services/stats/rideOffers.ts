import type { PrismaClient, RideOfferOutcome } from "@prisma/client";
import type { OfferClosedReason } from "@rida/shared";
import { logger } from "../../lib/logger";
import { noteRequestAnswer } from "../admin/liveRequests";

/**
 * Every request offered to a driver, and what became of it (RideOffer), for
 * the admin dashboard: accepted, declined, timed out, taken by another
 * driver, cancelled by the rider, or expired — and how long it took
 * (decidedAt − offeredAt). One row per ride and driver; the first answer
 * stands.
 *
 * Batched by nature: a broadcast is one insert for all its drivers, a
 * request closing is two updates for all of them. Recorded after the real
 * work and never fails it.
 */

function quietly(what: string, work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    (err) => logger.warn(`ride offers: ${what} failed`, { err }),
  );
}

/** A request was offered to these drivers (a re-broadcast keeps each driver's first time). */
export function recordOffers(
  prisma: PrismaClient,
  rideId: string,
  driverUserIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  if (driverUserIds.length === 0) return Promise.resolve();
  return quietly(
    "record",
    prisma.rideOffer.createMany({
      data: driverUserIds.map((driverUserId) => ({ rideId, driverUserId, offeredAt: now })),
      skipDuplicates: true,
    }),
  );
}

/** One driver answered: declined or let it time out. */
export function recordOfferAnswer(
  prisma: PrismaClient,
  rideId: string,
  driverUserId: string,
  outcome: Extract<RideOfferOutcome, "DECLINED" | "TIMED_OUT">,
  now: Date = new Date(),
): Promise<void> {
  noteRequestAnswer(rideId, driverUserId, outcome, now.getTime());
  return quietly(
    "answer",
    prisma.rideOffer.updateMany({
      where: { rideId, driverUserId, outcome: null },
      data: { outcome, decidedAt: now },
    }),
  );
}

const CLOSED_AS: Record<OfferClosedReason, RideOfferOutcome> = {
  TAKEN: "TAKEN",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
};

/**
 * The request closed (dispatch.closeOffer): the driver who took it, if any,
 * accepted; every other offer still open ends with the reason.
 */
export function recordOffersClosed(
  prisma: PrismaClient,
  rideId: string,
  reason: OfferClosedReason,
  takenBy: string | null,
  now: Date = new Date(),
): Promise<void> {
  return quietly(
    "close",
    (async () => {
      if (reason === "TAKEN" && takenBy) {
        await prisma.rideOffer.updateMany({
          where: { rideId, driverUserId: takenBy, outcome: null },
          data: { outcome: "ACCEPTED", decidedAt: now },
        });
      }
      await prisma.rideOffer.updateMany({
        where: { rideId, outcome: null },
        data: { outcome: CLOSED_AS[reason], decidedAt: now },
      });
    })(),
  );
}
