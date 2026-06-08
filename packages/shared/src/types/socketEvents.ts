import type { RideStatus } from "./ride";

/**
 * Real-time event contract for rider-facing ride tracking (Phase 5c).
 * The real driver app (Phase 6) and the dev-only mock driver
 * (apps/server/src/dev/mockDriver.ts) both emit exactly these events on the
 * `ride:{rideId}` room, so the rider app never needs to know which one is
 * driving the ride.
 */
export const RIDE_EVENTS = {
  DRIVER_ASSIGNED: "ride:driver_assigned",
  DRIVER_LOCATION: "ride:driver_location",
  STATUS: "ride:status",
  COMPLETED: "ride:completed",
} as const;

export type RideServerEvent = (typeof RIDE_EVENTS)[keyof typeof RIDE_EVENTS];

export interface DriverAssignedPayload {
  rideId: string;
  driverId: string;
  name: string;
  carMake: string | null;
  carModel: string | null;
  carColor: string | null;
  plate: string | null;
  /** Average of the driver's past ratings, or null if they have none yet. */
  rating: number | null;
}

export interface DriverLocationPayload {
  rideId: string;
  lat: number;
  lng: number;
  ts: number;
}

export interface RideStatusPayload {
  rideId: string;
  status: RideStatus;
}

export interface RideCompletedFareSummary {
  /** This rider's frozen fare for the ride, in integer pesewas. */
  yourFarePesewas: number;
  /** Total fare collected across all passengers, in integer pesewas. */
  totalFarePesewas: number;
}

export interface RideCompletedPayload {
  rideId: string;
  fareSummary: RideCompletedFareSummary;
}

export interface RideServerEventPayloads {
  "ride:driver_assigned": DriverAssignedPayload;
  "ride:driver_location": DriverLocationPayload;
  "ride:status": RideStatusPayload;
  "ride:completed": RideCompletedPayload;
}

/** Client -> server events: subscribe/unsubscribe to a ride's room. */
export const RIDE_CLIENT_EVENTS = {
  SUBSCRIBE: "ride:subscribe",
  UNSUBSCRIBE: "ride:unsubscribe",
} as const;

export type RideClientEvent = (typeof RIDE_CLIENT_EVENTS)[keyof typeof RIDE_CLIENT_EVENTS];
