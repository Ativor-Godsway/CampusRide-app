import type {
  DriverAssignedPayload,
  PaymentMethod,
  PaymentStatus,
  Ride,
  RideCompletedFareSummary,
  RidePassenger,
  RiderDecisionAction,
  RideType,
  Zone,
} from "@rida/shared";
import { api } from "../auth/apiClient";

export async function getZones(): Promise<Zone[]> {
  const res = await api.get<{ zones: Zone[] }>("/zones");
  return res.data.zones;
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
  constructor() {
    super("You already have an active ride");
    this.name = "ActiveRideExistsError";
  }
}

export async function createRide(input: CreateRideInput): Promise<Ride> {
  try {
    const res = await api.post<{ ride: Ride & { passengers: RidePassenger[] } }>("/rides", input);
    return res.data.ride;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 409) {
      throw new ActiveRideExistsError();
    }
    throw err;
  }
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
  return res.data;
}

export interface RideSummary extends Ride {
  pickupZone: Zone;
  dropoffZone: Zone;
}

/** The signed-in rider's past rides, newest first. */
export async function getMyRides(): Promise<RideSummary[]> {
  const res = await api.get<{ rides: RideSummary[] }>("/rides/mine");
  return res.data.rides;
}

export async function submitRideDecision(rideId: string, action: RiderDecisionAction): Promise<Ride> {
  const res = await api.post<{ ride: Ride }>(`/rides/${rideId}/decision`, { action });
  return res.data.ride;
}

export async function cancelRide(rideId: string): Promise<Ride> {
  const res = await api.post<{ ride: Ride }>(`/rides/${rideId}/cancel`);
  return res.data.ride;
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
  return res.data;
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
