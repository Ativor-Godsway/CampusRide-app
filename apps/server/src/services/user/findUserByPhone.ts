import type { PrismaClient, User } from "@prisma/client";
import { phoneVariants } from "../../lib/phone";

/**
 * Finds a user by phone number in ANY of the formats the column actually
 * holds.
 *
 * `User.phone` is now always canonical "+233XXXXXXXXX": the auth routes
 * normalize on the way in (routes/auth.ts) and a CHECK constraint enforces it
 * (migration 20260924210000_phone_canonicalisation). So this is no longer
 * about a mixed column — it is about mixed INPUT. An operator running
 * seedAdmin types "0548608146"; a USSD callback sends "233548608146"; a
 * pasted number carries spaces. Each must find the one canonical row.
 *
 * Historically the column WAS mixed, and a lookup by a single form missed rows
 * written by the other path — which is how seedAdmin came to report "no user
 * with phone +233548608146" for an account that plainly existed.
 *
 * `findFirst` over the equivalent forms rather than `findUnique` on one: each
 * form is unique on its own, and in the worst case (the same human registered
 * twice, once per path) this returns the canonical row first because
 * phoneVariants orders it first.
 *
 * Still the right way to look a user up by a number that came from a human or
 * an external system, even though the column itself is now uniform.
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
 * Every user whose phone matches any equivalent form of `rawPhone`.
 *
 * Since canonicalisation this should always return 0 or 1 rows — the unique
 * index and the CHECK constraint make two equivalent rows impossible. It is
 * kept plural so callers that must not act on an ambiguous number (seedAdmin)
 * can assert that invariant instead of assuming it.
 */
export async function findUsersByPhone(
  prisma: PrismaClient,
  rawPhone: string,
): Promise<User[]> {
  const variants = phoneVariants(rawPhone);
  if (variants.length === 0) return [];

  return prisma.user.findMany({ where: { phone: { in: variants } } });
}
