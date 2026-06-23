import type { PrismaClient, User } from "@prisma/client";
import { normalizePhone } from "../../lib/phone";

/** Thrown when the given phone number doesn't normalize to a valid Ghanaian number. */
export class InvalidPhoneError extends Error {
  constructor(phone: string) {
    super(`"${phone}" is not a valid Ghanaian phone number`);
    this.name = "InvalidPhoneError";
  }
}

/**
 * Finds the User matching a USSD rider's msisdn, or creates a lightweight
 * one (role RIDER, no password/OTP — USSD has no auth step) if none exists.
 * Phone is normalized first so a USSD "233XXXXXXXXX" matches an
 * app-registered "+233XXXXXXXXX". Does not touch RefreshToken/OTP/signup —
 * this is a separate, USSD-only path into the User table.
 */
export async function findOrCreateRiderByPhone(
  prisma: PrismaClient,
  msisdn: string,
): Promise<User> {
  const phone = normalizePhone(msisdn);
  if (!phone) {
    throw new InvalidPhoneError(msisdn);
  }

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    return existing;
  }

  return prisma.user.create({
    data: { phone, name: "USSD Rider", role: "RIDER" },
  });
}
