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
  | "MERGED_INTO_ANOTHER_RIDE";

export interface Ride {
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
  /** Set when this request was absorbed into another car (CANCELLED /
   *  MERGED_INTO_ANOTHER_RIDE) — points at the anchor ride to follow. */
  mergedIntoRideId: string | null;
  createdAt: Date;
  departedAt: Date | null;
  completedAt: Date | null;
  broadcastStartedAt: Date | null;
  decisionStartedAt: Date | null;
}

export interface RidePassenger {
  id: string;
  rideId: string;
  riderId: string;
  pickupZoneId: string;
  dropoffZoneId: string;
  fareCharged: number | null;
  lockedFare: number | null;
  status: PassengerStatus;
}
