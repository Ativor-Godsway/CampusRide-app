export type RideType = "LONE" | "SHARED";

export type RideStatus =
  | "REQUESTED"
  | "MATCHED"
  | "ARRIVED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "AWAITING_RIDER_DECISION";

export type PaymentStatus = "PENDING" | "COLLECTED" | "DISBURSED" | "FAILED";

export type PassengerStatus =
  | "WAITING"
  | "PICKED_UP"
  | "DROPPED_OFF"
  | "CANCELLED";

export type RideCancelReason =
  | "RIDER_CANCELLED"
  | "DRIVER_BACKED_OUT"
  | "NO_DRIVERS_AVAILABLE"
  | "ALL_PASSENGERS_LEFT";

export interface Ride {
  id: string;
  riderId: string;
  driverId: string | null;
  type: RideType;
  status: RideStatus;
  pickupZoneId: string;
  dropoffZoneId: string;
  occupancy: number;
  fareTotal: number | null;
  driverShare: number | null;
  paymentStatus: PaymentStatus;
  cancelReason: RideCancelReason | null;
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
