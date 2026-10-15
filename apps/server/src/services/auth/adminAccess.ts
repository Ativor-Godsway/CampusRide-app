import type { PrismaClient } from "@prisma/client";
import { config, type PhoneList } from "../../config";

/**
 * Whether `phone` may act as an admin: it must be on ADMIN_PHONE_ALLOWLIST,
 * whatever the database says about the account's role. A database row that
 * claims ADMIN (a mistaken or malicious edit, a promoted test account) gets
 * nowhere without the number also being on a list that lives only in Render.
 *
 * An empty list lets nobody in, in production. Outside production it lets
 * any ADMIN account in, so local work needs no setup.
 */
export function adminPhoneAllowed(
  phone: string,
  allowlist: PhoneList = config.adminPhoneAllowlist,
  nodeEnv: string = config.nodeEnv,
): boolean {
  if (allowlist.phones.length === 0) return nodeEnv !== "production";
  return allowlist.phones.includes(phone);
}

/** True for a number the admin-login rules apply to: on the allowlist, or an ADMIN account's. */
export async function isAdminNumber(prisma: PrismaClient, phone: string): Promise<boolean> {
  if (config.adminPhoneAllowlist.phones.includes(phone)) return true;
  const user = await prisma.user.findUnique({
    where: { phone },
    select: { role: true, deletedAt: true },
  });
  return user?.role === "ADMIN" && !user.deletedAt;
}

/** "+233548608146" -> "+233*****146": enough to recognise a number in a log, not to dial it. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return "*".repeat(phone.length);
  return `${phone.slice(0, 4)}*****${phone.slice(-3)}`;
}
