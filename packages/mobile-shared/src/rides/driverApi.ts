import type { PassengerStatus, Ride, RideSource, RideType, Zone } from "@rida/shared";
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
  /** Phase 6b-3: each passenger's own zone names, for the per-passenger driving view. */
  passengers: PassengerInCar[];
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

// ─── Completed-ride history (read-only, derived earnings) ────────────────────

export interface DriverRideHistoryItem {
  rideId: string;
  pickupZoneName: string;
  dropoffZoneName: string;
  type: RideType;
  source: RideSource;
  /** ISO timestamp the ride was marked COMPLETED. */
  completedAt: string;
  /** Face fare for the ride in pesewas (fixed model). */
  facePesewas: number;
  /** Driver's derived gross (85%) share in pesewas — accrued, not paid out. */
  driverGrossPesewas: number;
}

export interface DriverRideHistorySummary {
  totalRides: number;
  /** Sum of per-ride driver gross, pesewas. Gross accrued, not settled. */
  totalGrossPesewas: number;
}

export interface DriverRideHistory {
  rides: DriverRideHistoryItem[];
  summary: DriverRideHistorySummary;
}

/** Fetch the authenticated driver's completed rides + derived earnings summary. */
export async function getDriverRideHistory(): Promise<DriverRideHistory> {
  const res = await api.get<DriverRideHistory>("/driver/rides/history");
  return res.data;
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

/**
 * A pending SHARED request the driver can add to their car. ALL pending
 * addable requests are returned (not just compatible ones) — `compatible`
 * is a sort-order/badge hint only, never a filter; the driver may add any of
 * them. No fare-impact preview — shared fare is flat per rider.
 */
export interface FillSuggestion {
  requestRideId: string;
  pickupZoneName: string;
  pickupZoneId: string;
  dropoffZoneName: string;
  dropoffZoneId: string;
  createdAt: string;
  /** True for requests ranked compatible by the existing Phase-2c scoring — badge-eligible, sorted first. */
  compatible: boolean;
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

// ─── Per-passenger lifecycle (Phase 6b-3) ────────────────────────────────────

export interface RidePassengerRecord {
  id: string;
  rideId: string;
  riderId: string;
  pickupZoneId: string;
  dropoffZoneId: string;
  fareCharged: number | null;
  lockedFare: number | null;
  status: PassengerStatus;
}

export interface PassengerLifecycleResult {
  passenger: RidePassengerRecord;
  /** The anchor ride, including ALL passengers — its status may have changed
   * as a side effect (first pickup -> IN_PROGRESS, last dropoff -> COMPLETED). */
  ride: Ride & { passengers: RidePassengerRecord[] };
}

/** Driver has arrived at this one passenger's pickup point. WAITING -> ARRIVED. No ride-level effect. */
export async function passengerArrived(
  rideId: string,
  passengerId: string,
): Promise<PassengerLifecycleResult> {
  const res = await api.post<PassengerLifecycleResult>(
    `/rides/${rideId}/passengers/${passengerId}/arrived`,
  );
  return res.data;
}

/**
 * Driver has picked up this one passenger. ARRIVED -> PICKED_UP. If this is
 * the ride's first pickup, the ride itself walks to IN_PROGRESS as a side
 * effect — check the returned `ride.status` to detect that.
 */
export async function passengerPickup(
  rideId: string,
  passengerId: string,
): Promise<PassengerLifecycleResult> {
  const res = await api.post<PassengerLifecycleResult>(
    `/rides/${rideId}/passengers/${passengerId}/pickup`,
  );
  return res.data;
}

/**
 * Driver has dropped off this one passenger. PICKED_UP -> DROPPED_OFF. If no
 * passenger remains active, the ride itself completes as a side effect —
 * check the returned `ride.status` to detect that.
 */
export async function passengerDropoff(
  rideId: string,
  passengerId: string,
): Promise<PassengerLifecycleResult> {
  const res = await api.post<PassengerLifecycleResult>(
    `/rides/${rideId}/passengers/${passengerId}/dropoff`,
  );
  return res.data;
}
