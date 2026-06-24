export class InvalidTransitionError extends Error {
  readonly entity: "Ride" | "RidePassenger";
  readonly from: string;
  readonly to: string;

  constructor(entity: "Ride" | "RidePassenger", from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

/**
 * Thrown by claimRide when the ride was already claimed by another driver
 * (or is no longer REQUESTED) by the time the conditional update ran.
 */
export class RideAlreadyClaimedError extends Error {
  readonly rideId: string;

  constructor(rideId: string) {
    super(`Ride ${rideId} is already claimed or no longer REQUESTED`);
    this.name = "RideAlreadyClaimedError";
    this.rideId = rideId;
  }
}

/**
 * Thrown by claimRide when the claiming driver already has another ride in
 * an active status (MATCHED/ARRIVED/IN_PROGRESS) — a driver may hold at most
 * one active ride at a time, mirroring ActiveRideExistsError on the rider side.
 */
export class DriverHasActiveRideError extends Error {
  readonly existingRide: { id: string };

  constructor(existingRide: { id: string }) {
    super("Driver already has an active ride");
    this.name = "DriverHasActiveRideError";
    this.existingRide = existingRide;
  }
}

/**
 * Thrown by riderDecision(SWITCH_TO_LONE) when the ride does not have
 * exactly one active passenger.
 */
export class InvalidSwitchToLoneError extends Error {
  readonly activePassengerCount: number;

  constructor(activePassengerCount: number) {
    super(
      `riderDecision(SWITCH_TO_LONE) requires exactly 1 active passenger, found ${activePassengerCount}`,
    );
    this.name = "InvalidSwitchToLoneError";
    this.activePassengerCount = activePassengerCount;
  }
}

/**
 * Thrown by addRiderToCar/departRide when the calling driver does not own
 * (is not assigned as the driver of) the anchor ride.
 */
export class NotRideOwnerError extends Error {
  readonly rideId: string;
  readonly driverId: string;

  constructor(rideId: string, driverId: string) {
    super(`Ride ${rideId} is not owned by driver ${driverId}`);
    this.name = "NotRideOwnerError";
    this.rideId = rideId;
    this.driverId = driverId;
  }
}

/**
 * Thrown by addRiderToCar when the anchor ride is not in a fillable state
 * (must be MATCHED or ARRIVED — not yet IN_PROGRESS/COMPLETED/CANCELLED).
 */
export class RideNotFillableError extends Error {
  readonly rideId: string;
  readonly status: string;

  constructor(rideId: string, status: string) {
    super(`Ride ${rideId} is not fillable in status ${status} (must be MATCHED or ARRIVED)`);
    this.name = "RideNotFillableError";
    this.rideId = rideId;
    this.status = status;
  }
}

/** Thrown by addRiderToCar when the anchor ride has no free seats (occupancy >= 4). */
export class NoSeatsAvailableError extends Error {
  readonly rideId: string;

  constructor(rideId: string) {
    super(`Ride ${rideId} has no free seats`);
    this.name = "NoSeatsAvailableError";
    this.rideId = rideId;
  }
}

/**
 * Thrown by addRiderToCar when the request ride's pickup/dropoff zones are
 * not combinable (same-or-adjacent on both ends) with the anchor ride's.
 */
export class RidesNotCombinableError extends Error {
  readonly anchorRideId: string;
  readonly requestRideId: string;

  constructor(anchorRideId: string, requestRideId: string) {
    super(`Ride ${requestRideId} is not combinable with ride ${anchorRideId}`);
    this.name = "RidesNotCombinableError";
    this.anchorRideId = anchorRideId;
    this.requestRideId = requestRideId;
  }
}

/**
 * Thrown by addRiderToCar when the request ride is no longer an available
 * REQUESTED, unclaimed SHARED ride (already absorbed by another driver,
 * already matched, or cancelled).
 */
export class RequestRideUnavailableError extends Error {
  readonly requestRideId: string;

  constructor(requestRideId: string) {
    super(`Ride ${requestRideId} is no longer an available REQUESTED SHARED request`);
    this.name = "RequestRideUnavailableError";
    this.requestRideId = requestRideId;
  }
}

/**
 * Thrown by departRide when the ride is not ARRIVED (already departed,
 * never claimed, or cancelled).
 */
export class RideNotReadyToDepartError extends Error {
  readonly rideId: string;
  readonly status: string;

  constructor(rideId: string, status: string) {
    super(`Ride ${rideId} cannot depart from status ${status} (must be ARRIVED)`);
    this.name = "RideNotReadyToDepartError";
    this.rideId = rideId;
    this.status = status;
  }
}
