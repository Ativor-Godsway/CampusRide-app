import type { PrismaClient, Ride, RidePassenger } from "@prisma/client";
import type { PassengerStatus, RideStatus, RiderPushKind } from "@rida/shared";
import { emitRideEvent, emitToRider, removeRiderFromRide } from "../../realtime/rideSocket";
import { notifyRider } from "../push/notify";
import { notifyUssdRider } from "../sms/notifyUssdRiders";
import { getDriverInfo } from "../user/driverInfo";
import { closeOffer } from "./dispatch";
import { finalizeRideCompletion } from "./completion";
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
  }
  // Out of the car: their phone stops following it (after the events above,
  // so they still hear how their own trip ended).
  if (!isActivePassengerStatus(passenger.status)) removeRiderFromRide(passenger.riderId, ride.id);
}
