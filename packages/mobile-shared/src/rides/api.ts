import type {
  DriverAssignedPayload,
  PassengerStatus,
  PaymentMethod,
  PaymentStatus,
  Ride,
  RideCompletedFareSummary,
  RidePassenger,
  RiderCancelReason,
  RiderDecisionAction,
  RideStatus,
  RideType,
  Zone,
} from "@rida/shared";
import { asArray, readCursorPage, readList } from "@rida/shared";
import { api } from "../auth/apiClient";

/**
 * React Query cache keys for the rider's ride lists.
 *
 * Each key must hold ONE data shape. Home and the Rides tab both used
 * ["myRides"]: Home cached a plain array, the Rides tab read the same entry
 * as infinite-query pages, and React Query crashed reading `pages.length`
 * ("Cannot read property 'length' of undefined") on the Rides tab.
 * Both share the "myRides" prefix, so invalidating ["myRides"] refreshes both.
 */
export const myRidesQueryKeys = {
  /** Home's "recent" strip — a plain RideSummary[]. */
  recent: ["myRides", "recent"] as const,
  /** Rides tab history — useInfiniteQuery pages of RidePage. */
  history: ["myRides", "history"] as const,
};

export async function getZones(): Promise<Zone[]> {
  const res = await api.get<{ zones: Zone[] }>("/zones");
  return readList<Zone>(res.data, "zones");
}

export interface CreateRideInput {
  pickupZoneId: string;
  dropoffZoneId: string;
  type: RideType;
  paymentMethod?: PaymentMethod;
}

export interface CreateRideConflictError extends Error {
  isActiveRideConflict: true;
}

/** Thrown when the rider already has an active ride (backend returns 409). */
export class ActiveRideExistsError extends Error implements CreateRideConflictError {
  readonly isActiveRideConflict = true as const;
  /** The ride in the way, so the app can go straight to it (null from very old servers). */
  readonly activeRideId: string | null;
  constructor(activeRideId: string | null = null) {
    super("You already have an active ride");
    this.name = "ActiveRideExistsError";
    this.activeRideId = activeRideId;
  }
}

export async function createRide(input: CreateRideInput): Promise<Ride> {
  try {
    const res = await api.post<{ ride: Ride & { passengers: RidePassenger[] } }>("/rides", input);
    return res.data.ride;
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: unknown } }).response;
    if (response?.status === 409) {
      const data = (response.data ?? {}) as { activeRideId?: unknown; ride?: { id?: unknown } };
      const id = typeof data.activeRideId === "string" ? data.activeRideId : data.ride?.id;
      throw new ActiveRideExistsError(typeof id === "string" ? id : null);
    }
    throw err;
  }
}

/** Minimal zone info the active-ride banner and ride screen need. */
export interface ActiveRideZone {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/** The rider's ride that is still going on (GET /rides/active). */
export interface ActiveRideSummary {
  id: string;
  status: RideStatus;
  type: RideType;
  /** This rider's own leg; null if they have no seat row. */
  legStatus: PassengerStatus | null;
  /** The rider's OWN pickup/drop-off (differs from the ride's for a merged rider). */
  pickupZone: ActiveRideZone;
  dropoffZone: ActiveRideZone;
  driver: { firstName: string } | null;
}

/** One cache entry for "the rider's active ride", shared by the banner, launch check and ride screen. */
export const activeRideQueryKey = ["activeRide"] as const;

/** The rider's active ride, or null. Anything malformed reads as null rather than throwing in a render. */
export async function getActiveRide(): Promise<ActiveRideSummary | null> {
  const res = await api.get<{ ride: ActiveRideSummary | null }>("/rides/active");
  const ride = res.data?.ride;
  return ride && typeof ride.id === "string" && ride.pickupZone && ride.dropoffZone ? ride : null;
}

export interface RideWithDetails extends Ride {
  pickupZone: Zone;
  dropoffZone: Zone;
  passengers: RidePassenger[];
}

export type RideDriverInfo = Omit<DriverAssignedPayload, "rideId">;

export interface GetRideResult {
  ride: RideWithDetails;
  driver: RideDriverInfo | null;
  fareSummary?: RideCompletedFareSummary;
}

export async function getRide(rideId: string): Promise<GetRideResult> {
  const res = await api.get<GetRideResult>(`/rides/${rideId}`);
  const { ride } = res.data;
  return { ...res.data, ride: { ...ride, passengers: asArray(ride.passengers) } };
}

export interface RideSummary extends Ride {
  pickupZone: Zone;
  dropoffZone: Zone;
}

/** The signed-in rider's most recent rides, newest first (Home's "recent" strip). */
export async function getRecentRides(limit = 3): Promise<RideSummary[]> {
  return (await getMyRidesPage(undefined, limit)).rides;
}

export async function submitRideDecision(rideId: string, action: RiderDecisionAction): Promise<Ride> {
  const res = await api.post<{ ride: Ride }>(`/rides/${rideId}/decision`, { action });
  return res.data.ride;
}

export interface CancelRideInput {
  /** What the rider picked in the cancel sheet. */
  reason?: RiderCancelReason;
  /** Optional free text (with "Other"); at most RIDER_CANCEL_NOTE_MAX chars. */
  note?: string;
}

export async function cancelRide(rideId: string, input: CancelRideInput = {}): Promise<Ride> {
  const note = input.note?.trim();
  const res = await api.post<{ ride: Ride }>(`/rides/${rideId}/cancel`, {
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.reason && note ? { note } : {}),
  });
  return res.data.ride;
}

export interface SwitchRideTypeResult {
  ride: Ride;
  /** The rider's new locked fare, in pesewas. */
  farePesewas: number;
}

/**
 * Switches a still-searching ride between SHARED and LONE in place
 * (POST /rides/:id/switch). The server refuses with 409 once a driver has
 * claimed the ride; the rider then simply has their matched ride.
 */
export async function switchRideType(rideId: string, type: RideType): Promise<SwitchRideTypeResult> {
  const res = await api.post<SwitchRideTypeResult>(`/rides/${rideId}/switch`, { type });
  return res.data;
}

export interface SubmitRatingInput {
  rideId: string;
  stars: number;
  comment?: string;
}

export async function submitRating(input: SubmitRatingInput): Promise<void> {
  await api.post("/ratings", input);
}

export interface SosResult {
  /** Public tracking page URL that was texted out. */
  trackingUrl: string;
  /** Null when the rider has saved no emergency contact. */
  contactName: string | null;
  contactPhone: string | null;
  /** True when the rider's OWN contact was texted successfully. */
  smsDelivered: boolean;
  /** True when the fixed support number was texted successfully. */
  supportNotified: boolean;
  /** False when the rider should be nudged to add a contact. */
  hasEmergencyContact: boolean;
}

/**
 * Raises an SOS on an active ride. The server texts the rider's emergency
 * contact AND support with the current ride state and a live tracking link.
 *
 * Having no emergency contact is no longer an error — support is alerted
 * either way, and `hasEmergencyContact` tells the caller whether to nudge.
 */
export async function raiseSos(rideId: string): Promise<SosResult> {
  const res = await api.post<SosResult>(`/rides/${rideId}/sos`);
  return res.data;
}

/** One page of the rider's history, newest first. */
export interface RidePage {
  rides: RideSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * A page of the signed-in rider's past rides. Pass the previous page's
 * `nextCursor` to continue; omit it for the first page.
 */
export async function getMyRidesPage(cursor?: string, limit = 20): Promise<RidePage> {
  const res = await api.get<RidePage>("/rides/mine", { params: { cursor, limit } });
  const { items, nextCursor, hasMore } = readCursorPage<RideSummary>(res.data, "rides");
  return { rides: items, nextCursor, hasMore };
}

export type MoolreNetwork = "MTN" | "TELECEL" | "AT";

/**
 * "OTP_SENT" -> first prompt, show the OTP entry step. "OTP_RETRY" -> the
 * submitted otpcode didn't match, stay on OTP entry. "SUBMITTED" -> no OTP
 * needed (or it was just confirmed) — await the existing push-prompt/webhook
 * confirmation. null -> no OTP-related state (e.g. a definite failure).
 */
export type OtpStage = "OTP_SENT" | "OTP_RETRY" | "SUBMITTED" | null;

export interface InitiateRidePaymentResult {
  paymentStatus: PaymentStatus;
  otpStage: OtpStage;
}

/**
 * Initiate MOMO collection for the rider's completed ride leg, or confirm an
 * OTP after a prior "OTP_SENT"/"OTP_RETRY" response. otpcode must be omitted
 * on the first call and present on the confirmation call; phone/network must
 * be the SAME values sent on the first call. Idempotent.
 */
export async function initiateRidePayment(
  rideId: string,
  phone: string,
  network: MoolreNetwork,
  otpcode?: string,
): Promise<InitiateRidePaymentResult> {
  const res = await api.post<InitiateRidePaymentResult>(
    `/rides/${rideId}/initiate-payment`,
    { phone, network, otpcode },
  );
  return res.data;
}

/** Poll the rider's Moolre payment status for a completed MOMO ride. */
export async function pollPaymentStatus(rideId: string): Promise<{
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
}> {
  const res = await api.get<{ paymentStatus: PaymentStatus; paymentMethod: PaymentMethod }>(
    `/rides/${rideId}/payment-status`,
  );
  return res.data;
}
