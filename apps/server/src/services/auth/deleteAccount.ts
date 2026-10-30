import type { PrismaClient } from "@prisma/client";
import { ACTIVE_RIDE_STATUSES } from "../ride/createRide";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { driverPhotoPublicId, buildSignature } from "../uploads/cloudinarySignature";
import { forgetAccount } from "./accountStatus";
import { disconnectUser } from "../../realtime/rideSocket";

/**
 * Closing an account, in two steps (app stores require in-app deletion):
 *
 * 1. **Now** (`closeAccount`, confirmed with a code texted to the account's
 *    phone — asked for in the app, or by email and run by an admin): the
 *    person disappears. They can't sign in, every session and
 *    push token is gone, their name and number are replaced with
 *    placeholders everywhere the apps and the admin site look, a driver
 *    leaves dispatch. Their phone number is free for a new account at once.
 *    What a safety dispute or a police request could need — name, phone, a
 *    driver's plate and photo — is moved to `AccountDeletion`, which nothing
 *    in the apps or the admin site reads.
 * 2. **After the retention period** (`purgeDeletedAccounts`,
 *    ACCOUNT_DELETION_RETENTION_DAYS, default 90): those kept details are
 *    erased, with the person's free-text notes, exact pickup and drop-off
 *    pins, rating comments and a driver's photo on Cloudinary.
 *
 * Kept for good, without a name: trip records (when, which zones, the fare)
 * and drivers' cash commission records — the business's books — and the
 * audit log entries saying the account was closed and erased.
 */

/**
 * Thrown when the caller still has a ride in flight. Deleting mid-trip would
 * strand a driver (or a rider) on a live trip with a counterparty that no
 * longer has a name or a phone number, so the ride must end first.
 */
export class ActiveRideBlocksDeletionError extends Error {
  constructor(public readonly rideId: string) {
    super("You have a ride going on. Finish or cancel it first, then you can delete your account.");
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

const DAY_MS = 24 * 60 * 60_000;

/** The ride (as rider, passenger or driver) that blocks deleting this account, if any. */
export async function findRideBlockingDeletion(
  prisma: PrismaClient,
  userId: string,
): Promise<{ id: string } | null> {
  return prisma.ride.findFirst({
    where: {
      status: { in: ACTIVE_RIDE_STATUSES },
      OR: [
        {
          riderId: userId,
          NOT: { passengers: { some: { riderId: userId, status: "CANCELLED" } } },
        },
        { driverId: userId },
        {
          passengers: {
            some: { riderId: userId, status: { in: ["WAITING", "ARRIVED", "PICKED_UP"] } },
          },
        },
      ],
    },
    select: { id: true },
  });
}

/** Who closed the account, for its `account.delete` audit entry. */
export interface DeleteAccountOptions {
  /** User.id of the admin who ran it; the person themselves unless given. */
  actor?: string;
  /** A note for the audit entry (never a code or a full phone number). */
  reason?: string;
}

/**
 * Step 1: closes the account now. Throws ActiveRideBlocksDeletionError while
 * a ride is going on, AccountAlreadyDeletedError for a closed or unknown
 * account. Returns when the kept details will be erased.
 *
 * NOT a row delete: rides, ratings and commission records point at the user
 * and are the business's record of what happened. One transaction, so a
 * half-closed account (sessions revoked but the name still showing, or the
 * reverse) can't happen.
 *
 * The routes call `closeAccount`, which also ends the account's live
 * connections; this is the database half on its own.
 */
export async function deleteAccount(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
  options: DeleteAccountOptions = {},
): Promise<{ purgeAfter: Date }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { driver: true } });
  if (!user || user.deletedAt) throw new AccountAlreadyDeletedError();

  const activeRide = await findRideBlockingDeletion(prisma, userId);
  if (activeRide) throw new ActiveRideBlocksDeletionError(activeRide.id);

  const purgeAfter = new Date(now.getTime() + config.accountDeletionRetentionDays * DAY_MS);

  await prisma.$transaction(async (tx) => {
    // What a safety dispute could need, out of sight until it's erased.
    await tx.accountDeletion.create({
      data: {
        userId,
        requestedAt: now,
        purgeAfter,
        keptName: user.name,
        keptPhone: user.phone,
        keptPlate: user.driver?.plate ?? null,
        keptPhotoUrl: user.driver?.photoUrl ?? null,
      },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        name: DELETED_NAME_PLACEHOLDER,
        phone: deletedPhonePlaceholder(userId),
        deletedAt: now,
        // Someone else's number; nothing needs it once the account is closed.
        emergencyContactName: null,
        emergencyContactPhone: null,
      },
    });

    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });

    // Out of dispatch and out of the admin's driver lists.
    await tx.driver.updateMany({
      where: { userId },
      data: {
        plate: null,
        photoUrl: null,
        isOnline: false,
        isApproved: false,
        currentZoneId: null,
      },
    });

    // Stats: a driver's online session (if any) ends with the account.
    await tx.driverOnlineSession.updateMany({
      where: { driverUserId: userId, endedAt: null },
      data: { endedAt: now, endReason: "ACCOUNT_CLOSED" },
    });
    await tx.pushToken.deleteMany({ where: { userId } });
    await tx.trackingLink.deleteMany({ where: { riderId: userId } });
    await tx.otpCode.deleteMany({ where: { phone: user.phone } });

    await tx.adminAuditLog.create({
      data: {
        actor: options.actor ?? userId,
        action: "account.delete",
        target: userId,
        reason: options.reason ?? null,
        timestamp: now,
      },
    });
  });

  // Access tokens already handed out stop working on the next request,
  // rather than when the cached "account is open" answer runs out.
  forgetAccount(userId);
  return { purgeAfter };
}

/**
 * Closes an account the one way both routes do it: the in-app DELETE /me and
 * the admin site's emailed-request flow (routes/adminAccountDeletion.ts). The
 * same data goes, is kept and is erased whichever asked, which is what
 * campusride.app/delete-account promises. Throws as `deleteAccount` does.
 */
export async function closeAccount(
  prisma: PrismaClient,
  userId: string,
  options: DeleteAccountOptions = {},
): Promise<{ purgeAfter: Date }> {
  const result = await deleteAccount(prisma, userId, new Date(), options);
  // Its open sockets go too: a deleted account must not keep hearing rides.
  disconnectUser(userId);
  return result;
}

/** Deletes a driver's photo from Cloudinary. Best effort: false (and logged) if it can't. */
export async function destroyDriverPhoto(
  userId: string,
  cfg: { cloudName: string; apiKey: string; apiSecret: string } = config.cloudinary,
  fetchFn: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<boolean> {
  if (!cfg.cloudName || !cfg.apiKey || !cfg.apiSecret) return false;
  const params = {
    invalidate: true,
    public_id: driverPhotoPublicId(userId),
    timestamp: Math.floor(now.getTime() / 1000),
  };
  const body = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    api_key: cfg.apiKey,
    signature: buildSignature(params, cfg.apiSecret),
  });
  try {
    const res = await fetchFn(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/image/destroy`,
      {
        method: "POST",
        body,
        signal: AbortSignal.timeout(15_000),
      },
    );
    const data = (await res.json().catch(() => ({}))) as { result?: string };
    // "not found" means it's already gone, which is what we want.
    if (res.ok && (data.result === "ok" || data.result === "not found")) return true;
    logger.warn("Couldn't delete a closed account's driver photo from Cloudinary", {
      userId,
      status: res.status,
    });
    return false;
  } catch (err) {
    logger.warn("Couldn't delete a closed account's driver photo from Cloudinary", { userId, err });
    return false;
  }
}

/**
 * Step 2: erases what was kept for closed accounts whose retention period has
 * ended. Run by the server on a timer (index.ts) and at startup; repeating it
 * is harmless. Returns how many accounts it erased.
 */
export async function purgeDeletedAccounts(
  prisma: PrismaClient,
  now: Date = new Date(),
  options: {
    destroyPhoto?: (userId: string) => Promise<boolean>;
    userIds?: readonly string[];
  } = {},
): Promise<number> {
  const due = await prisma.accountDeletion.findMany({
    where: {
      purgedAt: null,
      purgeAfter: { lte: now },
      ...(options.userIds ? { userId: { in: [...options.userIds] } } : {}),
    },
    take: 50,
  });
  const destroyPhoto = options.destroyPhoto ?? ((userId: string) => destroyDriverPhoto(userId));

  for (const record of due) {
    const { userId } = record;
    if (record.keptPhotoUrl) await destroyPhoto(userId);
    const noPins = {
      pickupLat: null,
      pickupLng: null,
      pickupLabel: null,
      pickupPlaceId: null,
      dropoffLat: null,
      dropoffLng: null,
      dropoffLabel: null,
      dropoffPlaceId: null,
      pickupNote: null,
    };
    await prisma.$transaction([
      prisma.accountDeletion.update({
        where: { id: record.id },
        data: {
          purgedAt: now,
          keptName: null,
          keptPhone: null,
          keptPlate: null,
          keptPhotoUrl: null,
        },
      }),
      // Where they were picked up and dropped off, and what they wrote. The
      // trip itself (when, which zones, the fare) stays, without a name.
      prisma.ride.updateMany({
        where: { riderId: userId },
        data: { ...noPins, riderCancelNote: null },
      }),
      prisma.ridePassenger.updateMany({ where: { riderId: userId }, data: noPins }),
      prisma.rating.updateMany({ where: { raterId: userId }, data: { comment: null } }),
      prisma.refreshToken.deleteMany({ where: { userId } }),
      prisma.adminAuditLog.create({
        data: { actor: "system", action: "account.purge", target: userId, timestamp: now },
      }),
    ]);
  }
  if (due.length > 0)
    logger.info("Erased the kept details of closed accounts", { count: due.length });
  return due.length;
}
