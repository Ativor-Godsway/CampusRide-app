import type { PrismaClient, User } from "@prisma/client";
import { phoneVariants } from "../../lib/phone";

/**
 * Finds a user by phone number in ANY of the formats the column actually
 * holds.
 *
 * `User.phone` is not consistently normalized. The auth routes
 * (services/auth/authService.ts) store whatever string the client sent as the
 * unique key, so an app user who typed "0548608146" is stored in local form,
 * while the USSD and demo-OTP paths normalize first and store
 * "+233548608146". A lookup by one form therefore misses rows written by the
 * other — which is exactly how seedAdmin could report "no user with phone
 * +233548608146" for an account that plainly existed as "0548608146".
 *
 * `findFirst` over the equivalent forms rather than `findUnique` on one: each
 * form is unique on its own, and in the worst case (the same human registered
 * twice, once per path) this returns the canonical row first because
 * phoneVariants orders it first.
 *
 * This is a READ-side compatibility shim for a column that should be
 * normalized at the write side. It is not a substitute for that migration.
 */
export async function findUserByPhone(
  prisma: PrismaClient,
  rawPhone: string,
): Promise<User | null> {
  const variants = phoneVariants(rawPhone);
  if (variants.length === 0) return null;

  for (const phone of variants) {
    const user = await prisma.user.findUnique({ where: { phone } });
    if (user) return user;
  }
  return null;
}

/**
 * Every user whose phone matches any equivalent form of `rawPhone`. Used to
 * surface the duplicate-account case (the same person registered once through
 * the app and once through USSD) rather than silently picking one.
 */
export async function findUsersByPhone(
  prisma: PrismaClient,
  rawPhone: string,
): Promise<User[]> {
  const variants = phoneVariants(rawPhone);
  if (variants.length === 0) return [];

  return prisma.user.findMany({ where: { phone: { in: variants } } });
}
