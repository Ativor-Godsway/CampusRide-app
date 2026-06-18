import type { PassengerStatus, PaymentMethod, PaymentStatus, RideStatus, RideType } from "./ride";

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
  PASSENGER_STATUS: "ride:passenger_status",
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
  paymentMethod: PaymentMethod;
  /** Moolre collection status for this rider (PENDING until webhook confirms). */
  paymentStatus: PaymentStatus;
}

export interface RideCompletedPayload {
  rideId: string;
  fareSummary: RideCompletedFareSummary;
}

/**
 * Per-passenger lifecycle update (Phase 6b-3) — sent ONLY to the affected
 * rider's personal room (`emitToRider`), never broadcast to the whole ride
 * room, so other passengers on the same SHARED ride never see it.
 */
export interface PassengerStatusPayload {
  rideId: string;
  ridePassengerId: string;
  riderId: string;
  status: PassengerStatus;
}

export interface RideServerEventPayloads {
  "ride:driver_assigned": DriverAssignedPayload;
  "ride:driver_location": DriverLocationPayload;
  "ride:status": RideStatusPayload;
  "ride:completed": RideCompletedPayload;
  "ride:passenger_status": PassengerStatusPayload;
}

/** Client -> server events: subscribe/unsubscribe to a ride's room. */
export const RIDE_CLIENT_EVENTS = {
  SUBSCRIBE: "ride:subscribe",
  UNSUBSCRIBE: "ride:unsubscribe",
} as const;

export type RideClientEvent = (typeof RIDE_CLIENT_EVENTS)[keyof typeof RIDE_CLIENT_EVENTS];

// ─── Driver ──────────────────────────────────────────────────────────────────

/** Server → driver events emitted to the driver's personal socket room. */
export const DRIVER_EVENTS = {
  RIDE_BROADCAST: "ride:broadcast",
} as const;

export type DriverServerEvent = (typeof DRIVER_EVENTS)[keyof typeof DRIVER_EVENTS];

/** Payload emitted to eligible drivers when a new ride enters REQUESTED. */
export interface RideBroadcastPayload {
  rideId: string;
  pickupZoneName: string;
  dropoffZoneName: string;
  type: RideType;
  /** Total locked fare for the ride in integer pesewas. */
  farePesewas: number;
  /** Driver's 85% share in integer pesewas. */
  driverSharePesewas: number;
  /** Unix ms timestamp when the 90s broadcast window expires. */
  expiresAt: number;
}

/** Driver → server events. */
export const DRIVER_CLIENT_EVENTS = {
  /** Driver streams their GPS location during an active ride. */
  LOCATION_UPDATE: "driver:location",
} as const;

export type DriverClientEvent = (typeof DRIVER_CLIENT_EVENTS)[keyof typeof DRIVER_CLIENT_EVENTS];

/** Payload sent driver→server on every location ping during an active ride. */
export interface DriverLocationUpdatePayload {
  rideId: string;
  lat: number;
  lng: number;
}
