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

export type MoolreNetwork = "MTN" | "TELECEL" | "AT";

/** Initiate MOMO collection for the rider's completed ride leg. Idempotent. */
export async function initiateRidePayment(
  rideId: string,
  phone: string,
  network: MoolreNetwork,
): Promise<{ paymentStatus: PaymentStatus }> {
  const res = await api.post<{ paymentStatus: PaymentStatus }>(
    `/rides/${rideId}/initiate-payment`,
    { phone, network },
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
