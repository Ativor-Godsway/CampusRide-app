import type { PrismaClient } from "@prisma/client";
import {
  splitFare,
  type PaymentMethod,
  type PaymentStatus,
  type RideCompletedFareSummary,
  type RideSource,
} from "@rida/shared";
import { emitToRider } from "../../realtime/rideSocket";
import { getRidePaymentSummary } from "../payment/paymentFlow";
import { notifyUssdRiders } from "../sms/notifyUssdRiders";
import { paidFareTotal } from "./fares";

/**
 * Finalizes a COMPLETED ride's payment side: a CASH CommissionLedger upsert,
 * and a per-rider `ride:completed` fare summary emitted via `emitToRider` to
 * EACH billable passenger individually — not one ride-room broadcast carrying
 * a single fare. Shared by the ride-level `/complete` route (LONE rides), the
 * per-passenger last-dropoff auto-completion path (both in routes/driver.ts)
 * and the sweep that completes rides left in progress (./staleRides.ts).
 * Previously `/complete`
 * emitted ONE `ride:completed` event to the whole ride room using only
 * `ride.riderId`'s fare — correct for LONE (single passenger) but wrong for
 * every other SHARED passenger (masked only by the rider app's poll
 * fallback, which computes its own fareSummary per-requester).
 */
export async function finalizeRideCompletion(
  prisma: PrismaClient,
  ride: {
    id: string;
    type: "LONE" | "SHARED";
    occupancy: number;
    paymentMethod: string;
    source: RideSource;
  },
  driverUserId: string,
  /** The ride's passengers, when the caller already has them (saves reading them again). */
  passengersIfKnown?: ReadonlyArray<{
    riderId: string;
    status: string;
    lockedFare: number | null;
    fareCharged?: number | null;
  }>,
): Promise<void> {
  const paymentMethod = ride.paymentMethod as PaymentMethod;
  const passengers =
    passengersIfKnown ??
    (paymentMethod === "CASH"
      ? await prisma.ridePassenger.findMany({
          where: { rideId: ride.id },
          select: { riderId: true, status: true, lockedFare: true, fareCharged: true },
        })
      : undefined);

  if (paymentMethod === "CASH" && passengers) {
    // The fares the carried riders were quoted and paid (services/ride/fares),
    // never today's price list: a trip booked before a price change owes
    // commission on what was actually collected. Shared: the riders dropped
    // off (occupancy drops as seats are cancelled, and can be 0 at the end);
    // a trip that dropped nobody off owes nothing. Same rule as the history.
    const { commission } = splitFare(paidFareTotal(ride.type, passengers));
    // createMany + skipDuplicates is a single INSERT … ON CONFLICT DO NOTHING
    // (an upsert is two round trips); repeating it is harmless.
    await prisma.commissionLedger.createMany({
      data: [{ driverUserId, rideId: ride.id, amountPesewas: commission }],
      skipDuplicates: true,
    });
  }

  const { perPassenger, totalFarePesewas } = await riderFareSummaries(prisma, paymentMethod, ride.id, passengers);

  for (const p of perPassenger) {
    emitToRider(p.riderId, "ride:completed", {
      rideId: ride.id,
      fareSummary: fareSummaryFor(p, totalFarePesewas, paymentMethod),
    });
  }

  // USSD-origin riders have no app to receive ride:completed on, so they get
  // an SMS instead — covers both this ride-level /complete (LONE) and the
  // per-passenger last-dropoff auto-completion, since both call this
  // function. Fire-and-forget, never throws into the transition path.
  if (ride.source === "USSD") {
    void notifyUssdRiders(
      prisma,
      perPassenger.map((p) => p.riderId),
      "Trip complete. Thanks for riding CampusRide.",
    );
  }
}

/**
 * One rider of a Shared car is dropped off while others ride on: their trip
 * is over, so they get their own `ride:completed` fare summary now (the trip
 * screen shows the fare and the rating) instead of waiting for the last
 * drop-off. Nothing else happens here — the ride, the commission ledger and
 * the other riders are untouched until the ride completes
 * (finalizeRideCompletion), which tells every rider again.
 */
export async function announceRiderTripComplete(
  prisma: PrismaClient,
  ride: { id: string; paymentMethod: string },
  riderId: string,
  passengers: ReadonlyArray<{ riderId: string; status: string; lockedFare: number | null }>,
): Promise<void> {
  const paymentMethod = ride.paymentMethod as PaymentMethod;
  const { perPassenger, totalFarePesewas } = await riderFareSummaries(prisma, paymentMethod, ride.id, passengers);
  const mine = perPassenger.find((p) => p.riderId === riderId);
  if (!mine) return;
  emitToRider(riderId, "ride:completed", {
    rideId: ride.id,
    fareSummary: fareSummaryFor(mine, totalFarePesewas, paymentMethod),
  });
}

type RiderFare = { riderId: string; farePesewas: number; status: PaymentStatus };

/** Each billable rider's fare and payment state, and the car's total. */
async function riderFareSummaries(
  prisma: PrismaClient,
  paymentMethod: PaymentMethod,
  rideId: string,
  passengers: ReadonlyArray<{ riderId: string; status: string; lockedFare: number | null }> | undefined,
): Promise<{ perPassenger: RiderFare[]; totalFarePesewas: number }> {
  // A cash ride has no Payment rows, so its per-rider summary is known from
  // the passengers alone; MoMo needs the payment records.
  const perPassenger: RiderFare[] =
    paymentMethod === "CASH" && passengers
      ? passengers
          .filter((p) => p.status !== "CANCELLED" && p.lockedFare != null)
          .map((p) => ({
            riderId: p.riderId,
            farePesewas: p.lockedFare ?? 0,
            status: "PENDING" as const,
          }))
      : (await getRidePaymentSummary(prisma, rideId)).perPassenger;
  const totalFarePesewas = perPassenger.reduce((sum, p) => sum + p.farePesewas, 0);
  return { perPassenger, totalFarePesewas };
}

function fareSummaryFor(p: RiderFare, totalFarePesewas: number, paymentMethod: PaymentMethod): RideCompletedFareSummary {
  return {
    yourFarePesewas: p.farePesewas,
    totalFarePesewas,
    paymentMethod,
    paymentStatus: p.status,
  };
}
