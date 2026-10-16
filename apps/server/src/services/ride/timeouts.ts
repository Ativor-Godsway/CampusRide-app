import type { PrismaClient } from "@prisma/client";
import { DISPATCH_WINDOW_MS, RIDE_EVENTS, type RideSource } from "@rida/shared";
import { applyRideTransition } from "./rideService";
import { emitRideEvent } from "../../realtime/rideSocket";
import { notifyUssdRider } from "../sms/notifyUssdRiders";
import { closeOffer } from "./dispatch";
import { notifyRider } from "../push/notify";
import { config } from "../../config";
import { completeStaleRide, isStaleInProgress, staleCutoff } from "./staleRides";

/** Shared with the rider app's countdown, so the two can never disagree. */
const BROADCAST_TIMEOUT_MS = DISPATCH_WINDOW_MS;
const DECISION_GRACE_MS = 90_000;

const NO_DRIVER_NUDGE = "No driver yet. Dial *919*4007# and choose Check Status.";

interface RideTimeoutFields {
  status: string;
  createdAt: Date;
  broadcastStartedAt: Date | null;
  decisionStartedAt: Date | null;
  departedAt?: Date | null;
}

/**
 * True if a REQUESTED ride has been broadcast for >= 90s with no claim and
 * should move to AWAITING_RIDER_DECISION. Pure — driven by an injected `now`
 * so it's testable without wall-clock delays.
 */
export function shouldTimeout(ride: RideTimeoutFields, now: Date): boolean {
  if (ride.status !== "REQUESTED") return false;
  const start = ride.broadcastStartedAt ?? ride.createdAt;
  return now.getTime() - start.getTime() >= BROADCAST_TIMEOUT_MS;
}

/**
 * True if a ride has sat in AWAITING_RIDER_DECISION for >= 90s with no
 * rider action and should be auto-cancelled (NO_DRIVERS_AVAILABLE).
 */
export function shouldExpireDecision(ride: RideTimeoutFields, now: Date): boolean {
  if (ride.status !== "AWAITING_RIDER_DECISION") return false;
  if (!ride.decisionStartedAt) return false;
  return now.getTime() - ride.decisionStartedAt.getTime() >= DECISION_GRACE_MS;
}

interface TimeoutLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Finds rides needing a timeout-driven transition as of `now` and applies
 * them:
 * - REQUESTED rides broadcast >= 90s with no claim -> AWAITING_RIDER_DECISION
 * - AWAITING_RIDER_DECISION rides idle >= 90s -> CANCELLED (NO_DRIVERS_AVAILABLE)
 * - IN_PROGRESS rides under way >= RIDE_AUTO_COMPLETE_HOURS (3) -> COMPLETED
 *   (a driver who never tapped "complete": ./staleRides.ts)
 *
 * `now` is injectable so this can be driven by tests with controlled time.
 * An optional `rideIds` filter restricts the scan to a specific set of rides
 * (used by tests to avoid touching fixtures created by other test files
 * sharing the same database).
 *
 * Resilient by design: the candidate scan uses a `select` (not a full row
 * fetch) and is a single short query, and any failure — the scan itself, or
 * an individual ride's transition (e.g. a transient Neon P2024/P1001 pool
 * error) — is caught, logged as a warning, and skips that ride/cycle rather
 * than throwing. A bad cycle or a single bad ride never takes down the
 * interval or blocks the rest of the sweep.
 */
export async function processTimeouts(
  prisma: PrismaClient,
  now: Date = new Date(),
  options: { rideIds?: readonly string[]; logger?: TimeoutLogger; autoCompleteAfterHours?: number } = {},
) {
  const autoCompleteHours = options.autoCompleteAfterHours ?? config.rideAutoCompleteHours;
  const cutoff = staleCutoff(now, autoCompleteHours);
  const logger = options.logger ?? console;
  const transitioned: { rideId: string; from: string; to: string }[] = [];

  let candidates: (RideTimeoutFields & {
    id: string;
    riderId: string;
    source: RideSource;
    pickupZoneId: string;
    departedAt: Date | null;
  })[];
  try {
    candidates = await prisma.ride.findMany({
      where: {
        OR: [
          { status: { in: ["REQUESTED", "AWAITING_RIDER_DECISION"] } },
          {
            status: "IN_PROGRESS",
            OR: [{ departedAt: { lt: cutoff } }, { departedAt: null, createdAt: { lt: cutoff } }],
          },
        ],
        ...(options.rideIds ? { id: { in: [...options.rideIds] } } : {}),
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        broadcastStartedAt: true,
        decisionStartedAt: true,
        departedAt: true,
        riderId: true,
        source: true,
        pickupZoneId: true,
      },
    });
  } catch (err) {
    logger.warn({ err }, "processTimeouts: failed to scan for timed-out rides, skipping cycle");
    return transitioned;
  }

  for (const ride of candidates) {
    try {
      if (shouldTimeout(ride, now)) {
        await applyRideTransition(prisma, ride.id, "AWAITING_RIDER_DECISION", {}, now);
        emitRideEvent(ride.id, RIDE_EVENTS.STATUS, { rideId: ride.id, status: "AWAITING_RIDER_DECISION" });
        // Its window is over: no driver should still be looking at the offer.
        closeOffer(prisma, ride, "EXPIRED");
        notifyRider(prisma, ride.riderId, "NO_DRIVER_FOUND", ride.id);
        logger.info({ rideId: ride.id }, "[timeout] REQUESTED → AWAITING_RIDER_DECISION");
        transitioned.push({ rideId: ride.id, from: ride.status, to: "AWAITING_RIDER_DECISION" });
        // USSD riders have no socket to receive AWAITING_RIDER_DECISION on
        // and no way to act on the KEEP_WAITING/SWITCH_TO_LONE/CANCEL
        // decision (that flow is deferred) — this nudge is the only signal
        // they get that something needs their attention before the 90s
        // auto-cancel.
        if (ride.source === "USSD") {
          void notifyUssdRider(prisma, ride.riderId, NO_DRIVER_NUDGE);
        }
      } else if (shouldExpireDecision(ride, now)) {
        await applyRideTransition(
          prisma,
          ride.id,
          "CANCELLED",
          { cancelReason: "NO_DRIVERS_AVAILABLE" },
          now,
        );
        emitRideEvent(ride.id, RIDE_EVENTS.STATUS, { rideId: ride.id, status: "CANCELLED" });
        logger.info({ rideId: ride.id }, "[timeout] AWAITING_RIDER_DECISION → CANCELLED (no rider action)");
        transitioned.push({ rideId: ride.id, from: ride.status, to: "CANCELLED" });
      } else if (isStaleInProgress(ride, now, autoCompleteHours)) {
        if (await completeStaleRide(prisma, ride.id, now)) {
          logger.warn(
            { rideId: ride.id, alert: "ride_auto_completed" },
            `[timeout] IN_PROGRESS for ${autoCompleteHours} h → COMPLETED (the driver never completed it)`,
          );
          transitioned.push({ rideId: ride.id, from: ride.status, to: "COMPLETED" });
        }
      }
    } catch (err) {
      logger.warn({ err, rideId: ride.id }, "processTimeouts: failed to transition ride, skipping");
    }
  }

  return transitioned;
}
