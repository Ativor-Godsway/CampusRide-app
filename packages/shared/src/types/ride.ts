import type { SeatWait } from "../rides/waitFee";
import type { RiderCancelReason } from "../rides/riderCancel";
import type { RidePinFields } from "../rides/ridePins";
export type RideType = "LONE" | "SHARED";

/** USSD vs app-originated ride — drives SMS vs push notification on transitions. */
export type RideSource = "APP" | "USSD";

export type RideStatus =
  | "REQUESTED"
  | "MATCHED"
  | "ARRIVED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "AWAITING_RIDER_DECISION";

export type PaymentStatus = "PENDING" | "COLLECTED" | "DISBURSED" | "FAILED";

export type PaymentMethod = "CASH" | "MOMO";

export type PassengerStatus =
  | "WAITING"
  | "ARRIVED"
  | "PICKED_UP"
  | "DROPPED_OFF"
  | "CANCELLED";

export type RiderDecisionAction = "KEEP_WAITING" | "SWITCH_TO_LONE" | "CANCEL";

export type RideCancelReason =
  | "RIDER_CANCELLED"
  | "DRIVER_BACKED_OUT"
  | "NO_DRIVERS_AVAILABLE"
  | "ALL_PASSENGERS_LEFT"
  | "MERGED_INTO_ANOTHER_RIDE"
  /** An admin cancelled it from the admin site (reason in the admin audit log). */
  | "ADMIN_CANCELLED";

/**
 * Exact pins are optional on these types: absent from servers before
 * October 2026, null on rides booked without them (see rides/ridePins.ts).
 */
export interface Ride extends Partial<RidePinFields> {
  id: string;
  riderId: string;
  driverId: string | null;
  type: RideType;
  status: RideStatus;
  source: RideSource;
  pickupZoneId: string;
  dropoffZoneId: string;
  occupancy: number;
  fareTotal: number | null;
  driverShare: number | null;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  cancelReason: RideCancelReason | null;
  /** What the RIDER said when they cancelled (feedback); null if not a rider cancel. */
  riderCancelReason?: RiderCancelReason | null;
  riderCancelNote?: string | null;
  /** Set when this request was absorbed into another car (CANCELLED /
   *  MERGED_INTO_ANOTHER_RIDE) — points at the anchor ride to follow. */
  mergedIntoRideId: string | null;
  createdAt: Date;
  departedAt: Date | null;
  completedAt: Date | null;
  broadcastStartedAt: Date | null;
  decisionStartedAt: Date | null;
}

export interface RidePassenger extends Partial<RidePinFields> {
  id: string;
  rideId: string;
  riderId: string;
  pickupZoneId: string;
  dropoffZoneId: string;
  fareCharged: number | null;
  /** This booking's fare (all its seats), including a wait fee charged at pickup. */
  lockedFare: number | null;
  status: PassengerStatus;
  /**
   * Seats this booking takes (Shared: 1–3) or people in it (Ride alone:
   * 1–4), rides/seats.ts. Absent from older servers: 1.
   */
  seats?: number;
  /**
   * The rider's own seat only (GET /rides/:id): their pickup wait while the
   * driver is there (rides/waitFee.ts), and a wait fee charged (already in
   * lockedFare). Absent from older servers and on other riders' seats.
   */
  wait?: SeatWait | null;
  waitFeePesewas?: number | null;
}
