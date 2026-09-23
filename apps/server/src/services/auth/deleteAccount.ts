import type { PrismaClient } from "@prisma/client";
import { ACTIVE_RIDE_STATUSES } from "../ride/createRide";

/**
 * Thrown when the caller still has a ride in flight. Deleting mid-trip would
 * strand a driver (or a rider) on a live trip with a counterparty that no
 * longer has a name or a phone number, so the ride must end first.
 */
export class ActiveRideBlocksDeletionError extends Error {
  constructor(public readonly rideId: string) {
    super("Finish or cancel your active ride before deleting your account");
    this.name = "ActiveRideBlocksDeletionError";
  }
}

/** Thrown when the account does not exist or was already deleted. */
export class AccountAlreadyDeletedError extends Error {
  constructor() {
    super("Account not found or already deleted");
    this.name = "AccountAlreadyDeletedError";
  }
}

/**
 * The placeholder phone written over the real one. It must stay UNIQUE
 * (User.phone is a unique column) and must never look like a dialable
 * number, so a deleted account can never be matched by an OTP login: the
 * lookup is by exact phone string, and no real phone can equal this.
 */
export function deletedPhonePlaceholder(userId: string): string {
  return `deleted:${userId}`;
}

export const DELETED_NAME_PLACEHOLDER = "Deleted user";

/**
 * Anonymizes a user's account in place and ends every session.
 *
 * NOT a row delete. Ride.riderId is `onDelete: Restrict`, and beyond that
 * constraint the ride history, CommissionLedger debt rows and Payment records
 * are financial record that must survive the person leaving. So the identity
 * columns are overwritten and everything else is left exactly as it stands:
 *
 *   - name/phone  -> placeholders; the phone is unique per user id so the
 *                    unique index still holds and no OTP login can match it.
 *   - deletedAt   -> set, marking the account closed.
 *   - refresh tokens -> all revoked, so no session can be extended.
 *   - driver profile -> plate and photo cleared (both identify a person),
 *                    taken offline and un-approved so dispatch skips them.
 *
 * Runs in a transaction: a partial deletion that revoked tokens but left the
 * name in place, or vice versa, is worse than either outcome.
 */
export async function deleteAccount(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) {
    throw new AccountAlreadyDeletedError();
  }

  // A rider's own request, or a driver's assigned ride — either blocks.
  const activeRide = await prisma.ride.findFirst({
    where: {
      status: { in: ACTIVE_RIDE_STATUSES },
      OR: [{ riderId: userId }, { driverId: userId }, { passengers: { some: { riderId: userId } } }],
    },
  });
  if (activeRide) {
    throw new ActiveRideBlocksDeletionError(activeRide.id);
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        name: DELETED_NAME_PLACEHOLDER,
        phone: deletedPhonePlaceholder(userId),
        deletedAt: now,
      },
    });

    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });

    await tx.driver.updateMany({
      where: { userId },
      data: { plate: null, photoUrl: null, isOnline: false, isApproved: false, currentZoneId: null },
    });
  });
}
