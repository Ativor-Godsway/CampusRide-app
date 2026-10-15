import type { PrismaClient, UserRole } from "@prisma/client";

/**
 * "Is the account behind this access token still open, and what is its role
 * NOW?" — asked on every authenticated HTTP request and socket handshake.
 *
 * An access token is valid for 30 minutes on its signature alone, so without
 * this a deleted account kept working until its token expired, and a role
 * change (an admin removed by hand) did not take effect until the person
 * logged in again. The role in the token is now only a hint; the database
 * decides.
 *
 * Answers are cached for a few seconds so a busy screen polling the API does
 * not add a query per request. deleteAccount calls forgetAccount, so on this
 * server a deletion takes effect at once; with several server instances the
 * others would notice within ACCOUNT_CACHE_TTL_MS (see
 * docs/security/route-inventory.md).
 */

export interface ActiveAccount {
  userId: string;
  role: UserRole;
}

export const ACCOUNT_CACHE_TTL_MS = 10_000;
/** Bounds memory: far more than the people signed in at once on a campus. */
const ACCOUNT_CACHE_MAX = 10_000;

const cache = new Map<string, { account: ActiveAccount | null; at: number }>();

/**
 * The open account for `userId`, or null when it does not exist or has been
 * deleted (DELETE /me sets deletedAt).
 */
export async function loadActiveAccount(
  prisma: PrismaClient,
  userId: string,
  now: number = Date.now(),
): Promise<ActiveAccount | null> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < ACCOUNT_CACHE_TTL_MS) return hit.account;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, deletedAt: true },
  });
  const account = user && !user.deletedAt ? { userId: user.id, role: user.role } : null;

  if (cache.size >= ACCOUNT_CACHE_MAX) {
    // Maps iterate in insertion order: drop the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(userId);
  cache.set(userId, { account, at: now });
  return account;
}

/** Drops any cached answer for this account, so its next request re-reads it. */
export function forgetAccount(userId: string): void {
  cache.delete(userId);
}
