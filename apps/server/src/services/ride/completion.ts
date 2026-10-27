import type { PrismaClient } from "@prisma/client";
import { splitFare, type PaymentMethod, type RideSource } from "@rida/shared";
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

  // A cash ride has no Payment rows, so its per-rider summary is known from
  // the passengers alone; MoMo needs the payment records.
  const perPassenger =
    paymentMethod === "CASH" && passengers
      ? passengers
          .filter((p) => p.status !== "CANCELLED" && p.lockedFare != null)
          .map((p) => ({
            riderId: p.riderId,
            farePesewas: p.lockedFare ?? 0,
            status: "PENDING" as const,
          }))
      : (await getRidePaymentSummary(prisma, ride.id)).perPassenger;
  const totalFarePesewas = perPassenger.reduce((sum, p) => sum + p.farePesewas, 0);

  for (const p of perPassenger) {
    emitToRider(p.riderId, "ride:completed", {
      rideId: ride.id,
      fareSummary: {
        yourFarePesewas: p.farePesewas,
        totalFarePesewas,
        paymentMethod,
        paymentStatus: p.status,
      },
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
