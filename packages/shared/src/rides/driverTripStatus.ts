import type { PassengerStatus, RideStatus, RideType } from "../types/ride";

export interface DriverTripStatusInput {
  type: RideType;
  status: RideStatus;
  pickupZoneName: string;
  dropoffZoneName: string;
  passengerStatuses: readonly PassengerStatus[];
}

/** One short line for the driver's active-trip banner, from the trip's real state. */
export function driverTripStatusLine(trip: DriverTripStatusInput): string {
  if (trip.type === "SHARED") {
    const riders = trip.passengerStatuses.filter(
      (s) => s === "WAITING" || s === "ARRIVED" || s === "PICKED_UP",
    ).length;
    const count = `${riders} rider${riders === 1 ? "" : "s"}`;
    return trip.status === "IN_PROGRESS"
      ? `Shared trip under way · ${count}`
      : `Filling your car · ${count}`;
  }
  if (trip.status === "MATCHED") return `Head to pickup: ${trip.pickupZoneName}`;
  if (trip.status === "ARRIVED") return `Waiting for your rider at ${trip.pickupZoneName}`;
  return `On trip to ${trip.dropoffZoneName}`;
}

/**
 * Where "back to my trip" leads for a driver: a LONE trip is driven on its
 * own screen; a SHARED car is run from Home (fill the car, then per-rider
 * pickups and drop-offs).
 */
export function driverTripHref(trip: { id: string; type: RideType }): "/" | `/ride/${string}` {
  return trip.type === "LONE" ? `/ride/${trip.id}` : "/";
}
