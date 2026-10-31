import type { Prisma } from "@prisma/client";
import { FLAGGED_RIDER_CANCEL_REASONS, RIDER_CANCEL_REASON_LABELS, maskPhone } from "@rida/shared";
import { rideFareForAdmin } from "../ride/fares";
import { cancelledBy } from "./facts";

/**
 * One ride as every admin list shows it (Rides, Overview, Cancellations,
 * a rider's rides). Phone numbers are masked ("+233*****146"): the full
 * number is only in a person's detail panel. Exact pins are not in lists.
 */
export const RIDE_ROW_SELECT = {
  id: true,
  status: true,
  type: true,
  source: true,
  occupancy: true,
  createdAt: true,
  completedAt: true,
  cancelledAt: true,
  cancelReason: true,
  riderCancelReason: true,
  riderCancelNote: true,
  paymentMethod: true,
  pickupLabel: true,
  dropoffLabel: true,
  // The fare is read from the seats (Ride.fareTotal is never written).
  passengers: { select: { status: true, lockedFare: true, fareCharged: true } },
  rider: { select: { id: true, name: true, phone: true } },
  driver: { select: { id: true, name: true, driver: { select: { id: true, plate: true } } } },
  pickupZone: { select: { id: true, name: true } },
  dropoffZone: { select: { id: true, name: true } },
} satisfies Prisma.RideSelect;

export type RideRowSource = Prisma.RideGetPayload<{ select: typeof RIDE_ROW_SELECT }>;

/** A person's number for a list: masked; a closed account's placeholder isn't a number at all. */
export function listPhone(phone: string): string | null {
  return phone.startsWith("+233") ? maskPhone(phone) : null;
}

export function rideRow(ride: RideRowSource) {
  const fare = rideFareForAdmin(ride.type, ride.status, ride.passengers);
  return {
    id: ride.id,
    createdAt: ride.createdAt.toISOString(),
    completedAt: ride.completedAt?.toISOString() ?? null,
    cancelledAt: ride.cancelledAt?.toISOString() ?? null,
    status: ride.status,
    type: ride.type,
    source: ride.source,
    paymentMethod: ride.paymentMethod,
    /** Seats still on it (or carried, once completed). */
    seats: ride.passengers.filter((p) => p.status !== "CANCELLED").length || ride.occupancy,
    /** Pesewas, from the seats' stored fares; null for a cancelled ride. */
    fareTotal: fare.pesewas,
    fareFinal: fare.final,
    rider: { id: ride.rider.id, name: ride.rider.name, maskedPhone: listPhone(ride.rider.phone) },
    driver: ride.driver
      ? { id: ride.driver.id, driverId: ride.driver.driver?.id ?? null, name: ride.driver.name, plate: ride.driver.driver?.plate ?? null }
      : null,
    pickup: ride.pickupLabel ?? ride.pickupZone.name,
    dropoff: ride.dropoffLabel ?? ride.dropoffZone.name,
    pickupZone: ride.pickupZone,
    dropoffZone: ride.dropoffZone,
    cancelReason: ride.cancelReason,
    cancelledBy: cancelledBy(ride),
    riderCancelReason: ride.riderCancelReason,
    riderCancelReasonLabel: ride.riderCancelReason ? RIDER_CANCEL_REASON_LABELS[ride.riderCancelReason] : null,
    riderCancelNote: ride.riderCancelNote,
    riderCancelFlagged: ride.riderCancelReason !== null && FLAGGED_RIDER_CANCEL_REASONS.includes(ride.riderCancelReason),
  };
}

export type RideRow = ReturnType<typeof rideRow>;
