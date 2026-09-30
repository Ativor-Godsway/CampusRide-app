import type { PrismaClient } from "@prisma/client";
import { isSimulatorPhone, simAccountWhere } from "./simAccounts";

export interface SimCleanupReport {
  accounts: number;
  rides: number;
  passengerRows: number;
  ratings: number;
  ledgerRows: number;
  payments: number;
  rejections: number;
  refreshTokens: number;
  otpCodes: number;
}

/** Thrown when a simulator ride also carries a real (non-simulator) rider. */
export class SimCleanupEntangledError extends Error {
  constructor(readonly rideIds: string[]) {
    super(
      `${rideIds.length} simulator ride(s) also carry a real rider, so deleting them would ` +
        `delete someone else's trip: ${rideIds.slice(0, 10).join(", ")}. Nothing was deleted.`,
    );
    this.name = "SimCleanupEntangledError";
  }
}

/**
 * Deletes every simulator account (docs/testing/SOLO_TESTING.md) and
 * everything attached to it: its rides, passenger rows, ratings, commission
 * ledger rows, payments, driver rejections, refresh tokens and OTP codes.
 *
 * Scope: ONLY users matching simAccountWhere (the +233099… range, a "Test "
 * name and the RIDER role), re-checked phone by phone in code. Other accounts
 * are never deleted — including the real driver who carried the fake riders;
 * only the rows describing those fake trips go.
 *
 * Where a fake rider was added to a REAL rider's car, only the fake rider's
 * seat on it is removed, never the ride. Where a real rider sits in a fake
 * rider's ride, it refuses (SimCleanupEntangledError) and deletes nothing.
 *
 * One transaction: it either removes everything or nothing.
 */
export async function cleanupSimulatorData(prisma: PrismaClient): Promise<SimCleanupReport> {
  const users = (
    await prisma.user.findMany({ where: simAccountWhere, select: { id: true, phone: true } })
  ).filter((u) => isSimulatorPhone(u.phone));

  const empty: SimCleanupReport = {
    accounts: 0, rides: 0, passengerRows: 0, ratings: 0, ledgerRows: 0,
    payments: 0, rejections: 0, refreshTokens: 0, otpCodes: 0,
  };
  if (users.length === 0) return empty;

  const ids = users.map((u) => u.id);
  const phones = users.map((u) => u.phone);

  // Rides requested by a fake rider. (Rides where a fake rider merely has a
  // seat are someone else's and stay.)
  const rideIds = (
    await prisma.ride.findMany({ where: { riderId: { in: ids } }, select: { id: true } })
  ).map((r) => r.id);

  const entangled = await prisma.ride.findMany({
    where: {
      id: { in: rideIds },
      OR: [
        { passengers: { some: { riderId: { notIn: ids } } } },
        { mergedRides: { some: { riderId: { notIn: ids } } } },
      ],
    },
    select: { id: true },
  });
  if (entangled.length > 0) throw new SimCleanupEntangledError(entangled.map((r) => r.id));

  return prisma.$transaction(
    async (tx) => {
      const report = { ...empty, accounts: users.length, rides: rideIds.length };
      const onRides = { rideId: { in: rideIds } };

      report.ratings += (await tx.rating.deleteMany({ where: onRides })).count;
      report.passengerRows += (await tx.ridePassenger.deleteMany({ where: onRides })).count;
      report.payments += (await tx.payment.deleteMany({ where: onRides })).count;
      report.ledgerRows += (await tx.commissionLedger.deleteMany({ where: onRides })).count;
      report.rejections += (await tx.rideRejection.deleteMany({ where: onRides })).count;

      // The fake riders' traces on rides that are not theirs.
      report.passengerRows += (await tx.ridePassenger.deleteMany({ where: { riderId: { in: ids } } })).count;
      report.ratings += (
        await tx.rating.deleteMany({ where: { OR: [{ raterId: { in: ids } }, { rateeId: { in: ids } }] } })
      ).count;
      report.payments += (await tx.payment.deleteMany({ where: { riderId: { in: ids } } })).count;
      report.refreshTokens = (await tx.refreshToken.deleteMany({ where: { userId: { in: ids } } })).count;
      report.otpCodes = (await tx.otpCode.deleteMany({ where: { phone: { in: phones } } })).count;

      // A request merged into another fake ride points at it; unlink first.
      await tx.ride.updateMany({
        where: { mergedIntoRideId: { in: rideIds } },
        data: { mergedIntoRideId: null },
      });
      await tx.ride.deleteMany({ where: { id: { in: rideIds } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });

      return report;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
