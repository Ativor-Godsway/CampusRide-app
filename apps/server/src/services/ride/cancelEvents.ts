import type { PrismaClient } from "@prisma/client";
import type { RideStatus } from "@rida/shared";
import { emitRideEvent, emitToRider, removeRiderFromRide } from "../../realtime/rideSocket";
import { logger } from "../../lib/logger";
import { notifyRider, notifyRiderCancelled } from "../push/notify";
import { notifyUssdRider } from "../sms/notifyUssdRiders";
import type { AdminCancelResult, DriverCancelResult } from "./cancels";
import { finalizeRideCompletion } from "./completion";
import { broadcastRide, closeOffer, reofferToDriver } from "./dispatch";
import { sendRiderEtasNow } from "./riderEta";

/**
 * What everyone hears after a driver's or an admin's cancel
 * (services/ride/cancels.ts). Run after the reply; callers catch.
 *
 * Kept to events and pushes app builds already on phones understand: a
 * rider app from before these changes sees its ride searching again (a
 * requeue) or its seat cancelled (a rebook — it says "Driver cancelled" and
 * its Home banner then shows the new search); a driver app sees its trip
 * end or a seat go, exactly as after a rider's cancel.
 */

const DRIVER_CANCEL_SMS = "Your driver had to cancel. We're finding you another driver.";

/** After a driver's "Cancel pickup". */
export async function announceDriverCancel(
  prisma: PrismaClient,
  result: Extract<DriverCancelResult, { changed: true }>,
  driverUserId: string,
): Promise<void> {
  const { passenger, ride } = result;
  const riderId = passenger.riderId;

  if (result.mode === "requeued") {
    // Same ride, same room: the rider's screen goes back to "Finding your
    // driver"; the driver's (also in the room) sees its trip end.
    emitRideEvent(ride.id, "ride:status", { rideId: ride.id, status: "REQUESTED", driverCancelled: true });
    emitToRider(riderId, "ride:passenger_status", {
      rideId: ride.id,
      ridePassengerId: passenger.id,
      riderId,
      status: "WAITING",
    });
    notifyRider(prisma, riderId, "DRIVER_CANCELLED", ride.id, { driverUserId, rebooked: true });
    if (ride.source === "USSD") void notifyUssdRider(prisma, riderId, DRIVER_CANCEL_SMS);
    await broadcastRide(prisma, ride.id);
    reofferToDriver(prisma, driverUserId);
    return;
  }

  // Rebooked: their seat in this car is cancelled, their new request searches.
  emitToRider(riderId, "ride:passenger_status", {
    rideId: ride.id,
    ridePassengerId: passenger.id,
    riderId,
    status: "CANCELLED",
    rebookedRideId: result.rebookedRide.id,
    cancelledBy: "driver",
  });
  if (ride.status !== result.rideStatusBefore) {
    emitRideEvent(ride.id, "ride:status", { rideId: ride.id, status: ride.status as RideStatus });
  }
  notifyRider(prisma, riderId, "DRIVER_CANCELLED", result.rebookedRide.id, { driverUserId, rebooked: true });
  if (result.rebookedRide.source === "USSD") void notifyUssdRider(prisma, riderId, DRIVER_CANCEL_SMS);
  removeRiderFromRide(riderId, ride.id);
  if (ride.status === "COMPLETED" && result.rideStatusBefore !== "COMPLETED") {
    await finalizeRideCompletion(prisma, ride, driverUserId, ride.passengers);
  }
  await broadcastRide(prisma, result.rebookedRide.id);
  reofferToDriver(prisma, driverUserId);
  if (ride.status !== "COMPLETED" && ride.status !== "CANCELLED") await sendRiderEtasNow(prisma, ride.id, driverUserId);
}

/** After an admin cancelled one seat or a whole ride. */
export async function announceAdminCancel(
  prisma: PrismaClient,
  result: AdminCancelResult,
  scope: "seat" | "ride",
): Promise<void> {
  const { ride, rideStatusBefore, cancelledSeats } = result;
  if (!result.changed) return;
  const driverId = ride.driverId;

  for (const seat of cancelledSeats) {
    emitToRider(seat.riderId, "ride:passenger_status", {
      rideId: ride.id,
      ridePassengerId: seat.id,
      riderId: seat.riderId,
      status: "CANCELLED",
      cancelledBy: "admin",
    });
    removeRiderFromRide(seat.riderId, ride.id);
  }
  // The ride's room (its driver, and riders whose app reads the ride's status).
  emitRideEvent(ride.id, "ride:status", { rideId: ride.id, status: ride.status as RideStatus });

  // A ride with no seat rows (very old) still has its booker to tell.
  const riderIds = cancelledSeats.length ? [...new Set(cancelledSeats.map((s) => s.riderId))] : [ride.riderId];
  notifyRider(prisma, riderIds, "DRIVER_CANCELLED", ride.id, { byAdmin: true });
  if (ride.source === "USSD") {
    for (const riderId of riderIds) void notifyUssdRider(prisma, riderId, "CampusRide cancelled your ride. You can request another.");
  }
  notifyRiderCancelled(
    prisma,
    { id: ride.id, riderId: scope === "seat" ? (cancelledSeats[0]?.riderId ?? null) : null, driverId },
    { byAdmin: true },
  );

  // Drivers who were being offered it drop it at once.
  if ((rideStatusBefore === "REQUESTED" || rideStatusBefore === "AWAITING_RIDER_DECISION") && ride.status === "CANCELLED") {
    closeOffer(prisma, ride, "CANCELLED");
  }
  if (driverId && ride.status === "COMPLETED" && rideStatusBefore !== "COMPLETED") {
    await finalizeRideCompletion(prisma, ride, driverId, ride.passengers);
  }
  // Seats freed or the trip ended: the driver's lists are worked out again.
  reofferToDriver(prisma, driverId);
  if (driverId && ride.status !== "COMPLETED" && ride.status !== "CANCELLED") {
    await sendRiderEtasNow(prisma, ride.id, driverId).catch((err) => logger.warn("admin cancel: ETAs failed", { rideId: ride.id, err }));
  }
}
