import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { plainIp } from "../../lib/security";
import { maskPhone } from "../auth/adminAccess";

/**
 * Every attempt to sign in to the admin site, kept in AdminAuditLog so the
 * owner can spot a stranger (say, after a SIM swap) on "Recent admin logins".
 *
 *   admin.login.code_sent   a code went to an admin number (or the admin site asked for one)
 *   admin.login.failure     refused; `reason` says why
 *   admin.login.success     an admin session started (reason "passkey" when by passkey)
 *
 * Recorded for a request from the admin site, and for ANY request about an
 * admin's number (from whatever app), so trying an admin number through the
 * rider app is recorded too.
 */
export type AdminLoginOutcome = "code_sent" | "failure" | "success";

export type AdminLoginFailure =
  | "bad_code"
  | "code_expired"
  | "too_many_attempts"
  | "rate_limited"
  | "no_account"
  | "not_admin"
  | "not_allowlisted"
  | "invalid_verification"
  /** A phone code for an admin who has a passkey (ADMIN_OTP_FALLBACK off). */
  | "passkey_required"
  /** A passkey sign-in that didn't verify, or a passkey not registered here. */
  | "passkey_failed";

/** The admin site marks its own auth requests with this header. */
export const ADMIN_CLIENT_HEADER = "x-campusride-client";

export function isAdminSiteRequest(request: FastifyRequest): boolean {
  return request.headers[ADMIN_CLIENT_HEADER] === "admin";
}

export async function recordAdminLogin(
  prisma: PrismaClient,
  request: FastifyRequest,
  event: {
    outcome: AdminLoginOutcome;
    phone: string;
    /** The account, when there is one. */
    userId?: string | null;
    reason?: AdminLoginFailure | "passkey";
  },
): Promise<void> {
  const userAgent = request.headers["user-agent"];
  try {
    await prisma.adminAuditLog.create({
      data: {
        actor: event.userId ?? "unknown",
        action: `admin.login.${event.outcome}`,
        // An account by id; a number with no account only partly, since it
        // may be a stranger's.
        target: event.userId ?? (event.phone ? maskPhone(event.phone) : "passkey"),
        reason: event.reason ?? null,
        ip: plainIp(request.ip).slice(0, 64),
        userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
      },
    });
  } catch (err) {
    // Never let the record of a login break the login itself.
    request.log.error(
      { err, event: "admin_login_audit_failed" },
      "Could not record an admin login event",
    );
  }
}
