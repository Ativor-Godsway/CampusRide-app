import type { PrismaClient, Ride } from "@prisma/client";
import { RIDE_EVENTS } from "@rida/shared";
import { emitRideEvent, removeRiderFromRide } from "../../realtime/rideSocket";
import { reportMessage } from "../../lib/monitoring";
import { applyPassengerTransition, applyRideTransition } from "./rideService";
import { finalizeRideCompletion } from "./completion";
import { isActivePassengerStatus } from "./stateMachine";

/**
 * Rides a driver left in progress (Stage 6). Once a ride is IN_PROGRESS only
 * the driver can end it, and nobody can cancel it; if the driver never taps
 * "complete" (a dead phone, a forgotten tap) the riders in it could never
 * book again. So after `hours` in progress (RIDE_AUTO_COMPLETE_HOURS,
 * default 3: no campus trip takes that long), the timeout sweep
 * (./timeouts.ts) finishes it the way the driver would have.
 *
 * Nothing here depends on server memory: a ride left in progress before a
 * restart or a deploy is found by the next sweep like any other.
 */

interface StaleCheckFields {
  status: string;
  createdAt: Date;
  departedAt: Date | null;
}

/** True for an IN_PROGRESS ride under way for at least `hours` (from departure, or creation for older rows). */
export function isStaleInProgress(ride: StaleCheckFields, now: Date, hours: number): boolean {
  if (ride.status !== "IN_PROGRESS") return false;
  const since = ride.departedAt ?? ride.createdAt;
  return now.getTime() - since.getTime() >= hours * 60 * 60_000;
}

/** The oldest `departedAt` (or `createdAt`) that counts as stale at `now`. */
export function staleCutoff(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60_000);
}

/**
 * Finishes a ride left in progress, through the same steps as the driver's
 * app: every rider who was picked up is dropped off (their fare is recorded),
 * every rider still waiting to be picked up is released from the car, and
 * the last of these completes the ride. Then the usual completion follows:
 * the cash commission record and each rider's fare summary. No push
 * notification: it would arrive hours late, possibly at night; the apps see
 * the ride as finished the next time they look.
 *
 * Returns false (and changes nothing) if the ride is no longer in progress.
 */
export async function completeStaleRide(
  prisma: PrismaClient,
  rideId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: { passengers: { orderBy: { createdAt: "asc" } } },
  });
  if (!ride || ride.status !== "IN_PROGRESS") return false;

  const active = ride.passengers.filter((p) => isActivePassengerStatus(p.status));
  const released = active.filter((p) => p.status !== "PICKED_UP");
  const carried = active.filter((p) => p.status === "PICKED_UP");

  // Released first, dropped off last, so the final drop-off is what completes the ride.
  let finished: Ride = ride;
  let passengers = ride.passengers;
  for (const passenger of [...released, ...carried]) {
    const leaving = passenger.status !== "PICKED_UP";
    const result = await applyPassengerTransition(
      prisma,
      passenger.id,
      leaving ? "CANCELLED" : "DROPPED_OFF",
      now,
    );
    finished = result.ride;
    passengers = result.ride.passengers;
    if (leaving) removeRiderFromRide(passenger.riderId, ride.id);
  }
  // A ride with nobody left on board (older data) is completed directly.
  if (finished.status !== "COMPLETED")
    finished = await applyRideTransition(prisma, ride.id, "COMPLETED", {}, now);

  emitRideEvent(ride.id, RIDE_EVENTS.STATUS, { rideId: ride.id, status: "COMPLETED" });
  if (ride.driverId) await finalizeRideCompletion(prisma, finished, ride.driverId, passengers);

  const hours =
    Math.round(((now.getTime() - (ride.departedAt ?? ride.createdAt).getTime()) / 3_600_000) * 10) /
    10;
  reportMessage("A ride left in progress was completed automatically", {
    level: "warning",
    tags: { alert: "ride_auto_completed" },
    extra: {
      rideId: ride.id,
      hoursInProgress: hours,
      droppedOff: carried.length,
      released: released.length,
    },
  });
  return true;
}
