import type { PrismaClient } from "@prisma/client";
import { applyRideTransition } from "./rideService";

const BROADCAST_TIMEOUT_MS = 90_000;
const DECISION_GRACE_MS = 90_000;

interface RideTimeoutFields {
  status: string;
  createdAt: Date;
  broadcastStartedAt: Date | null;
  decisionStartedAt: Date | null;
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
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Finds rides needing a timeout-driven transition as of `now` and applies
 * them:
 * - REQUESTED rides broadcast >= 90s with no claim -> AWAITING_RIDER_DECISION
 * - AWAITING_RIDER_DECISION rides idle >= 90s -> CANCELLED (NO_DRIVERS_AVAILABLE)
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
  options: { rideIds?: readonly string[]; logger?: TimeoutLogger } = {},
) {
  const logger = options.logger ?? console;
  const transitioned: { rideId: string; from: string; to: string }[] = [];

  let candidates: (RideTimeoutFields & { id: string })[];
  try {
    candidates = await prisma.ride.findMany({
      where: {
        status: { in: ["REQUESTED", "AWAITING_RIDER_DECISION"] },
        ...(options.rideIds ? { id: { in: [...options.rideIds] } } : {}),
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        broadcastStartedAt: true,
        decisionStartedAt: true,
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
        transitioned.push({ rideId: ride.id, from: ride.status, to: "AWAITING_RIDER_DECISION" });
      } else if (shouldExpireDecision(ride, now)) {
        await applyRideTransition(
          prisma,
          ride.id,
          "CANCELLED",
          { cancelReason: "NO_DRIVERS_AVAILABLE" },
          now,
        );
        transitioned.push({ rideId: ride.id, from: ride.status, to: "CANCELLED" });
      }
    } catch (err) {
      logger.warn({ err, rideId: ride.id }, "processTimeouts: failed to transition ride, skipping");
    }
  }

  return transitioned;
}
