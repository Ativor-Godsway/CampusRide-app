import type { PrismaClient, Ride, RidePassenger } from "@prisma/client";
import type { PassengerStatus, RideStatus, RiderPushKind } from "@rida/shared";
import { addRiderToRide, emitRideEvent, emitToRider, removeRiderFromRide } from "../../realtime/rideSocket";
import { notifyRider } from "../push/notify";
import { notifyUssdRider } from "../sms/notifyUssdRiders";
import { getDriverInfo } from "../user/driverInfo";
import { closeOffer, reofferToDriver } from "./dispatch";
import { announceRiderTripComplete, finalizeRideCompletion } from "./completion";
import { sendRiderEtasNow } from "./riderEta";
import { isActivePassengerStatus } from "./stateMachine";

/**
 * What riders hear after a driver acts on a ride: live events, push
 * notifications, a text for USSD riders, the completion bookkeeping. Shared
 * by the driver routes (routes/driver.ts) and the review demo's simulated
 * driver (services/reviewDemo), so a demo trip looks exactly like a real one.
 * Run after the reply; never throws into the caller's path (callers catch).
 */

/** After a driver accepted a request. */
export async function announceClaim(
  prisma: PrismaClient,
  ride: Ride,
  driverUserId: string,
): Promise<void> {
  // Every other driver it was offered to drops it from their offers now.
  closeOffer(prisma, ride, "TAKEN");
  emitRideEvent(ride.id, "ride:status", { rideId: ride.id, status: ride.status as RideStatus });
  notifyRider(prisma, ride.riderId, "DRIVER_ASSIGNED", ride.id, { driverUserId });
  const driverInfo = await getDriverInfo(prisma, driverUserId);
  if (driverInfo)
    emitRideEvent(ride.id, "ride:driver_assigned", { rideId: ride.id, ...driverInfo });
  if (ride.source === "USSD")
    void notifyUssdRider(prisma, ride.riderId, "Driver matched! They're on the way.");
}

/** The push notification each per-passenger action sends that rider. */
const PASSENGER_PUSH: Partial<Record<PassengerStatus, RiderPushKind>> = {
  ARRIVED: "DRIVER_ARRIVED",
  PICKED_UP: "TRIP_STARTED",
  DROPPED_OFF: "TRIP_COMPLETED",
  CANCELLED: "DRIVER_CANCELLED",
};

/** After a driver changed one rider's seat (arrived, picked up, dropped off, cancelled). */
export async function announcePassengerChange(
  prisma: PrismaClient,
  change: {
    passenger: RidePassenger;
    ride: Ride & { passengers: RidePassenger[] };
    rideStatusBefore: RideStatus;
    driverUserId: string;
    noShow?: boolean;
  },
): Promise<void> {
  const { passenger, ride, rideStatusBefore, driverUserId, noShow } = change;
  emitToRider(passenger.riderId, "ride:passenger_status", {
    rideId: ride.id,
    ridePassengerId: passenger.id,
    riderId: passenger.riderId,
    status: passenger.status as PassengerStatus,
  });
  if (ride.status !== rideStatusBefore) {
    emitRideEvent(ride.id, "ride:status", { rideId: ride.id, status: ride.status as RideStatus });
  }
  const pushKind = PASSENGER_PUSH[passenger.status as PassengerStatus];
  if (pushKind) notifyRider(prisma, passenger.riderId, pushKind, ride.id, { driverUserId, noShow });
  if (passenger.status === "ARRIVED" && ride.source === "USSD") {
    void notifyUssdRider(prisma, passenger.riderId, "Your driver has arrived.");
  }
  if (ride.status === "COMPLETED" && rideStatusBefore !== "COMPLETED") {
    await finalizeRideCompletion(
      prisma,
      {
        id: ride.id,
        type: ride.type,
        occupancy: ride.occupancy,
        paymentMethod: ride.paymentMethod,
        source: ride.source,
      },
      driverUserId,
      ride.passengers,
    );
  } else if (passenger.status === "DROPPED_OFF") {
    // Dropped off while others ride on: this rider's own trip is complete.
    await announceRiderTripComplete(prisma, ride, passenger.riderId, ride.passengers);
  }
  // Out of the car: their phone stops following it (after the events above,
  // so they still hear how their own trip ended).
  if (!isActivePassengerStatus(passenger.status)) removeRiderFromRide(passenger.riderId, ride.id);
  // A seat freed (drop-off, cancel, no-show) or the trip ended: requests
  // that fit the car now reach this driver at once.
  if (!isActivePassengerStatus(passenger.status)) reofferToDriver(prisma, driverUserId);
  // The riders still in or waiting for the car: fresh ETAs now.
  if (ride.status !== "COMPLETED" && ride.status !== "CANCELLED") await sendRiderEtasNow(prisma, ride.id, driverUserId);
}

/**
 * After a driver undid a pickup or drop-off (the trip screen's "Undo"): the
 * rider's seat is back where it was, and so is the car's status if it
 * moved. No push — the rider's screen follows the events, and a second
 * notification for a slip of the finger would only confuse. A drop-off
 * undone puts the rider back in the car, so their phone follows it again
 * (the rider app clears the fare summary it was shown).
 */
export async function announcePassengerUndo(
  prisma: PrismaClient,
  change: {
    passenger: RidePassenger;
    ride: Ride & { passengers: RidePassenger[] };
    rideStatusBefore: RideStatus;
    driverUserId: string;
  },
): Promise<void> {
  const { passenger, ride, rideStatusBefore, driverUserId } = change;
  if (passenger.status === "PICKED_UP") addRiderToRide(passenger.riderId, ride.id);
  emitToRider(passenger.riderId, "ride:passenger_status", {
    rideId: ride.id,
    ridePassengerId: passenger.id,
    riderId: passenger.riderId,
    status: passenger.status as PassengerStatus,
  });
  if (ride.status !== rideStatusBefore) {
    emitRideEvent(ride.id, "ride:status", { rideId: ride.id, status: ride.status as RideStatus });
  }
  // An undone drop-off takes its seat back: the lists are worked out again.
  reofferToDriver(prisma, driverUserId);
  await sendRiderEtasNow(prisma, ride.id, driverUserId);
}
