import type { PrismaClient } from "@prisma/client";
import {
  getLoneFare,
  getSharedFarePerRider,
  splitFare,
  type PaymentMethod,
  type RideSource,
} from "@rida/shared";
import { emitToRider } from "../../realtime/rideSocket";
import { getRidePaymentSummary } from "../payment/paymentFlow";
import { notifyUssdRiders } from "../sms/notifyUssdRiders";

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
  passengers?: ReadonlyArray<{ riderId: string; status: string; lockedFare: number | null }>,
): Promise<void> {
  const paymentMethod = ride.paymentMethod as PaymentMethod;

  if (paymentMethod === "CASH") {
    // A shared car's fare is per rider actually carried. occupancy is not
    // that: it drops as seats are cancelled, and a trip that ends by
    // cancelling its last waiting rider completes with occupancy 0 (which
    // getSharedFarePerRider rejects). Same count the ride history uses.
    const carried = passengers?.filter((p) => p.status === "DROPPED_OFF").length ?? ride.occupancy;
    const farePesewasForLedger =
      ride.type === "LONE"
        ? getLoneFare()
        : carried > 0
          ? getSharedFarePerRider(carried) * carried
          : 0;
    const { commission } = splitFare(farePesewasForLedger);
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
