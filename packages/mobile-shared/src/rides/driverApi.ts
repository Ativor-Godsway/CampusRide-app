import type { PassengerStatus, Ride, RideSource, RideType, Zone } from "@rida/shared";
import { asArray, readList } from "@rida/shared";
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
  /**
   * Phase 4: the ride owner's contact details, so the driver can call them at
   * pickup. Present only on the driver's own ACTIVE ride. Null on a LONE ride
   * whose owner record could not be read.
   */
  riderName?: string | null;
  riderPhone?: string | null;
}

export interface SubmitDriverProfileInput {
  carMake: string;
  carModel: string;
  carColor: string;
  plate: string;
  /** The Cloudinary URL from uploadDriverPhoto; required by onboarding. */
  photoUrl?: string;
}

/** Submit / update the driver's car details and photo (POST /driver/profile). */
export async function submitDriverProfile(input: SubmitDriverProfileInput): Promise<DriverProfile> {
  const res = await api.post<{ driver: DriverProfile }>("/driver/profile", input);
  return res.data.driver;
}

/** Full driver profile (name from User + vehicle/photo from Driver). */
export interface DriverProfileFull {
  name: string;
  phone: string;
  carMake: string | null;
  carModel: string | null;
  carColor: string | null;
  plate: string | null;
  photoUrl: string | null;
  isApproved: boolean;
  isOnline: boolean;
}

/**
 * Partial profile edit. Every provided field must be non-empty (the server
 * rejects empty name and empty vehicle fields). Omitted fields are left as-is.
 */
export interface UpdateDriverProfileInput {
  name?: string;
  carMake?: string;
  carModel?: string;
  carColor?: string;
  plate?: string;
  photoUrl?: string;
}

/** Patch the driver's profile (PATCH /driver/profile). Caller should refreshMe() after. */
export async function updateDriverProfile(
  input: UpdateDriverProfileInput,
): Promise<DriverProfileFull> {
  const res = await api.patch<{ profile: DriverProfileFull }>("/driver/profile", input);
  return res.data.profile;
}

/** Set the driver online/offline and optionally update their current zone. */
export async function setDriverAvailability(
  isOnline: boolean,
  zoneId?: string,
  options?: { timeoutMs?: number },
): Promise<DriverProfile> {
  const res = await api.patch<{ driver: DriverProfile }>(
    "/driver/availability",
    {
      isOnline,
      ...(zoneId !== undefined ? { zoneId } : {}),
    },
    options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
  );
  return res.data.driver;
}

/**
 * Move an ONLINE driver's current zone as they drive (PATCH /driver/zone).
 * null clears it (outside the service area: no requests). Never changes
 * online status: the server answers 409 if the driver is offline.
 */
export async function updateDriverZone(zoneId: string | null): Promise<void> {
  await api.patch("/driver/zone", { zoneId });
}

/** Returns the driver's currently active ride (MATCHED/ARRIVED/IN_PROGRESS) or null. */
export interface RateableRider {
  riderId: string;
  name: string;
  /** Stars this driver has already given, or null if not rated yet. */
  stars: number | null;
}

/** The riders on a completed ride that this driver may rate. */
export async function getRateableRiders(rideId: string): Promise<RateableRider[]> {
  const res = await api.get<{ riders: RateableRider[] }>(`/rides/${rideId}/rateable-riders`);
  return readList<RateableRider>(res.data, "riders");
}

/** Driver rates one of their completed ride's riders. Upserts. */
export async function rateRider(input: {
  rideId: string;
  riderId: string;
  stars: number;
  comment?: string;
}): Promise<void> {
  await api.post("/ratings/rider", input);
}

/**
 * Explicitly decline a broadcast ride. Hides it from THIS driver's list
 * without withdrawing it from anyone else. Idempotent server-side.
 */
export async function rejectRide(rideId: string): Promise<void> {
  await api.post(`/rides/${rideId}/reject`);
}

export async function getDriverActiveRide(): Promise<RideWithZones | null> {
  const res = await api.get<{ ride: RideWithZones | null }>("/driver/rides/active");
  const ride = res.data?.ride;
  return ride ? { ...ride, passengers: asArray(ride.passengers) } : null;
}

/** Atomically claim a REQUESTED ride. Throws with status 409 if already claimed. */
export async function driverClaimRide(rideId: string, options?: { timeoutMs?: number }): Promise<Ride> {
  const res = await api.post<{ ride: Ride }>(
    `/rides/${rideId}/claim`,
    undefined,
    options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
  );
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
  /** The requesting rider's first name (newer servers). */
  riderFirstName?: string;
  pickupZoneName: string;
  pickupZoneId: string;
  dropoffZoneName: string;
  dropoffZoneId: string;
  type: RideType;
  /** Riders on the request. Optional: servers before the driver redesign don't send it. */
  seats?: number;
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
  return readList<EligibleRideItem>(res.data, "rides");
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
  /**
   * Phase 4: total 15% platform commission recorded against this driver on
   * completed CASH rides (CommissionLedger). An unenforced debt record — no
   * settlement mechanism exists yet — so this is everything on file, not an
   * unpaid balance.
   */
  commissionOwedPesewas: number;
  /** Gross minus commission owed. May be negative; deliberately not clamped. */
  netPesewas: number;
  /** How many completed rides carry a commission row (CASH rides only). */
  commissionRidesCount: number;
}

export interface DriverRideHistory {
  rides: DriverRideHistoryItem[];
  summary: DriverRideHistorySummary;
}

const EMPTY_HISTORY_SUMMARY: DriverRideHistorySummary = {
  totalRides: 0,
  totalGrossPesewas: 0,
  commissionOwedPesewas: 0,
  netPesewas: 0,
  commissionRidesCount: 0,
};

/** Fetch the authenticated driver's completed rides + derived earnings summary. */
export async function getDriverRideHistory(): Promise<DriverRideHistory> {
  const res = await api.get<DriverRideHistory>("/driver/rides/history");
  return {
    rides: readList<DriverRideHistoryItem>(res.data, "rides"),
    summary: { ...EMPTY_HISTORY_SUMMARY, ...res.data?.summary },
  };
}

// ─── Fill-your-car assembly (Phase 6b-2) ─────────────────────────────────────

/** A passenger already in the driver's shared car. */
export interface PassengerInCar {
  id: string;
  riderId: string;
  /** Phase 4: so the driver can identify and call this passenger at pickup. */
  riderName?: string | null;
  riderPhone?: string | null;
  pickupZoneName: string;
  dropoffZoneName: string;
  /** Zone ids, for placing the rider's stops on the map. Optional: older servers don't send them. */
  pickupZoneId?: string;
  dropoffZoneId?: string;
  /** The passenger's current downward-ratcheted fare in pesewas. */
  lockedFare: number | null;
  status: PassengerStatus;
  /** ISO time the driver reached this rider's pickup (wait timer, "rider didn't show"). */
  arrivedAt?: string | null;
}

/**
 * A pending SHARED request the driver can add to their car. ALL pending
 * addable requests are returned (not just compatible ones) — `compatible`
 * is a sort-order/badge hint only, never a filter; the driver may add any of
 * them. No fare-impact preview — shared fare is flat per rider.
 */
export interface FillSuggestion {
  requestRideId: string;
  /** The requesting rider's first name (newer servers). */
  riderFirstName?: string;
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
  return {
    ...res.data,
    passengers: readList<PassengerInCar>(res.data, "passengers"),
    suggestions: readList<FillSuggestion>(res.data, "suggestions"),
  };
}

/**
 * Adds a compatible SHARED request to the driver's claimed car.
 * Returns the updated passenger list with current locked fares.
 */
export async function addPassenger(
  rideId: string,
  requestRideId: string,
  options?: {
    timeoutMs?: number;
    /** The driver's position, for the server's detour check on a moving car. */
    position?: { latitude: number; longitude: number } | null;
  },
): Promise<AddPassengerResult> {
  const res = await api.post<AddPassengerResult>(
    `/rides/${rideId}/add-passenger`,
    {
      requestRideId,
      ...(options?.position ? { lat: options.position.latitude, lng: options.position.longitude } : {}),
    },
    options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
  );
  return { ...res.data, passengers: readList<PassengerInCar>(res.data, "passengers") };
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
  options?: { timeoutMs?: number },
): Promise<PassengerLifecycleResult> {
  const res = await api.post<PassengerLifecycleResult>(
    `/rides/${rideId}/passengers/${passengerId}/arrived`,
    undefined,
    options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
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
  options?: { timeoutMs?: number },
): Promise<PassengerLifecycleResult> {
  const res = await api.post<PassengerLifecycleResult>(
    `/rides/${rideId}/passengers/${passengerId}/pickup`,
    undefined,
    options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
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
  options?: { timeoutMs?: number },
): Promise<PassengerLifecycleResult> {
  const res = await api.post<PassengerLifecycleResult>(
    `/rides/${rideId}/passengers/${passengerId}/dropoff`,
    undefined,
    options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
  );
  return res.data;
}

/** A precomputed road route between two zones (GET /zones/routes). */
export interface ZoneRoute {
  fromZoneId: string;
  toZoneId: string;
  /** Google encoded polyline; decode with decodePolyline from @rida/shared. */
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
  /** "osrm" | "ors" — decides the attribution the map shows. */
  provider?: string;
}

/** Every stored zone-to-zone road route. Empty until the precompute script has run. */
export async function getZoneRoutes(): Promise<ZoneRoute[]> {
  const res = await api.get<{ routes: ZoneRoute[] }>("/zones/routes");
  return readList<ZoneRoute>(res.data, "routes");
}

/**
 * Cancel a passenger before pickup (WAITING -> CANCELLED). Server enforces
 * WAITING-only and broadcasts the cancellation to the rider.
 */
export async function passengerCancel(
  rideId: string,
  passengerId: string,
  options?: {
    timeoutMs?: number;
    /** "NO_SHOW": the rider didn't come out (allowed 3 minutes after arriving). */
    reason?: "NO_SHOW";
  },
): Promise<PassengerLifecycleResult> {
  const res = await api.post<PassengerLifecycleResult>(
    `/rides/${rideId}/passengers/${passengerId}/cancel`,
    options?.reason ? { reason: options.reason } : undefined,
    options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
  );
  return res.data;
}

// ─── Add-rider route preview ──────────────────────────────────────────────────

export interface AddRiderPreviewStop {
  key: string;
  kind: "PICKUP" | "DROPOFF";
  /** True for the new rider's pickup and drop-off. */
  isNew: boolean;
  riderFirstName: string;
  zoneId: string;
  zoneName: string;
  latitude: number;
  longitude: number;
}

export interface AddRiderPreviewResult {
  requestRideId: string;
  riderFirstName?: string;
  pickupZoneName: string;
  dropoffZoneName: string;
  farePesewas: number;
  driverSharePesewas: number;
  addedSeconds: number;
  addedMinutes: number;
  /** When the request stops being offered (ISO). */
  expiresAt: string;
  pickupIndex: number;
  dropoffIndex: number;
  /** Every remaining stop with the new rider slotted in, in order. */
  stops: AddRiderPreviewStop[];
  /** Encoded polylines (decodePolyline from @rida/shared). */
  currentPolyline: string;
  proposedPolyline: string;
}

/**
 * Where a waiting rider would slot into this car, the new route, the time it
 * adds and the extra fare. Read-only. Answers 409 (code REQUEST_UNAVAILABLE,
 * CAR_FULL or CAR_CLOSED) when the rider couldn't be added right now.
 */
export async function getAddRiderPreview(
  rideId: string,
  requestRideId: string,
  position: { latitude: number; longitude: number } | null,
): Promise<AddRiderPreviewResult> {
  const res = await api.get<AddRiderPreviewResult>(`/rides/${rideId}/add-preview`, {
    params: {
      requestRideId,
      ...(position ? { lat: position.latitude.toFixed(6), lng: position.longitude.toFixed(6) } : {}),
    },
  });
  return { ...res.data, stops: readList<AddRiderPreviewStop>(res.data, "stops") };
}
