import type { PassengerStatus, Ride, RideType, Zone } from "@rida/shared";
import { api } from "../auth/apiClient";

export interface DriverProfile {
  id: string;
  userId: string;
  carMake: string | null;
  carModel: string | null;
  carColor: string | null;
  plate: string | null;
  isApproved: boolean;
  isOnline: boolean;
  currentZoneId: string | null;
}

export interface RideWithZones extends Ride {
  pickupZone: Zone;
  dropoffZone: Zone;
}

export interface SubmitDriverProfileInput {
  carMake: string;
  carModel: string;
  carColor: string;
  plate: string;
}

/** Submit / update the driver's car details (POST /driver/profile). */
export async function submitDriverProfile(input: SubmitDriverProfileInput): Promise<DriverProfile> {
  const res = await api.post<{ driver: DriverProfile }>("/driver/profile", input);
  return res.data.driver;
}

/** Set the driver online/offline and optionally update their current zone. */
export async function setDriverAvailability(
  isOnline: boolean,
  zoneId?: string,
): Promise<DriverProfile> {
  const res = await api.patch<{ driver: DriverProfile }>("/driver/availability", {
    isOnline,
    ...(zoneId !== undefined ? { zoneId } : {}),
  });
  return res.data.driver;
}

/** Returns the driver's currently active ride (MATCHED/ARRIVED/IN_PROGRESS) or null. */
export async function getDriverActiveRide(): Promise<RideWithZones | null> {
  const res = await api.get<{ ride: RideWithZones | null }>("/driver/rides/active");
  return res.data.ride;
}

/** Atomically claim a REQUESTED ride. Throws with status 409 if already claimed. */
export async function driverClaimRide(rideId: string): Promise<Ride> {
  const res = await api.post<{ ride: Ride }>(`/rides/${rideId}/claim`);
  return res.data.ride;
}

/** Mark MATCHED → ARRIVED (driver reached pickup zone). */
export async function driverMarkArrived(rideId: string): Promise<Ride> {
  const res = await api.post<{ ride: Ride }>(`/rides/${rideId}/arrived`);
  return res.data.ride;
}

/** Depart with the rider: ARRIVED → IN_PROGRESS. */
export async function driverDepart(rideId: string): Promise<Ride> {
  const res = await api.post<{ ride: Ride }>(`/rides/${rideId}/depart`);
  return res.data.ride;
}

/** Complete the ride: IN_PROGRESS → COMPLETED. Returns driver's share in pesewas. */
export async function driverComplete(
  rideId: string,
): Promise<{ ride: Ride; driverSharePesewas: number }> {
  const res = await api.post<{ ride: Ride; driverSharePesewas: number }>(
    `/rides/${rideId}/complete`,
  );
  return res.data;
}

/** A single ride request the driver is eligible to claim. */
export interface EligibleRideItem {
  rideId: string;
  pickupZoneName: string;
  pickupZoneId: string;
  dropoffZoneName: string;
  dropoffZoneId: string;
  type: RideType;
  /** Base fare for the ride in pesewas (per-rider for SHARED, flat for LONE). */
  farePesewas: number;
  /** Driver's 85% share in pesewas. */
  driverSharePesewas: number;
  /** ISO timestamp when the ride was first requested (for "X min ago" display). */
  createdAt: string;
  /** True if this driver is the best-fit match for this ride (Phase-2e scoring). */
  bestFit: boolean;
}

/** Fetch the list of REQUESTED rides this driver is currently eligible to claim. */
export async function getEligibleRides(): Promise<EligibleRideItem[]> {
  const res = await api.get<{ rides: EligibleRideItem[] }>("/driver/rides/eligible");
  return res.data.rides;
}

// ─── Fill-your-car assembly (Phase 6b-2) ─────────────────────────────────────

/** A passenger already in the driver's shared car. */
export interface PassengerInCar {
  id: string;
  riderId: string;
  pickupZoneName: string;
  dropoffZoneName: string;
  /** The passenger's current downward-ratcheted fare in pesewas. */
  lockedFare: number | null;
  status: PassengerStatus;
}

/** A compatible SHARED request the driver can add to their car. */
export interface FillSuggestion {
  requestRideId: string;
  pickupZoneName: string;
  pickupZoneId: string;
  dropoffZoneName: string;
  dropoffZoneId: string;
  createdAt: string;
  /** How per-rider fares would change if this passenger is added. */
  fareImpact: {
    currentOccupancy: number;
    newOccupancy: number;
    /** Current standard rate per rider at currentOccupancy (pesewas). */
    currentFarePerRider: number;
    /** New standard rate per rider at newOccupancy after adding (pesewas). */
    newFarePerRider: number;
  };
}

export interface FillSuggestionsResult {
  occupancy: number;
  passengers: PassengerInCar[];
  suggestions: FillSuggestion[];
}

export interface AddPassengerResult {
  occupancy: number;
  passengers: PassengerInCar[];
}

/**
 * Returns ranked compatible SHARED requests that can be added to the anchor
 * ride, plus a fare-impact preview for each. Read-only — no DB writes.
 */
export async function getFillSuggestions(rideId: string): Promise<FillSuggestionsResult> {
  const res = await api.get<FillSuggestionsResult>(`/rides/${rideId}/fill-suggestions`);
  return res.data;
}

/**
 * Adds a compatible SHARED request to the driver's claimed car.
 * Returns the updated passenger list with current locked fares.
 */
export async function addPassenger(
  rideId: string,
  requestRideId: string,
): Promise<AddPassengerResult> {
  const res = await api.post<AddPassengerResult>(`/rides/${rideId}/add-passenger`, {
    requestRideId,
  });
  return res.data;
}
