import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { useRequestValidation } from "../http/validation";
import { MAX, object, phone as phoneField, text } from "../http/schemas";
import { adminOnly, requireAuth, requireAdmin } from "../middleware/auth";
import { normalizePhone } from "../lib/phone";
import { maskPhone } from "../lib/redact";
import type { OtpService } from "../services/otp/OtpService";
import { requestOtp, verifyOtp } from "../services/auth/otp";
import { isAdminNumber } from "../services/auth/adminAccess";
import { TOKEN } from "../services/auth/constants";
import { signDeletionConfirmToken, verifyDeletionConfirmToken } from "../services/auth/tokens";
import {
  InvalidOtpError,
  InvalidVerificationTokenError,
  OtpAttemptsExceededError,
  OtpExpiredError,
} from "../services/auth/errors";
import {
  AccountAlreadyDeletedError,
  ActiveRideBlocksDeletionError,
  closeAccount,
  findRideBlockingDeletion,
} from "../services/auth/deleteAccount";
import { RateLimitedError } from "../rateLimit/limiter";
import { clientIpForLimits, sendRateLimited } from "../rateLimit/reply";

/**
 * Deleting an account for someone who asked by email (the no-app route on
 * campusride.app/delete-account), from the admin site's "Delete account" tab:
 *
 *   GET  /admin/account-deletion?phone=   the account on that number, if any
 *   POST /admin/account-deletion/code     texts a code to that number
 *   POST /admin/account-deletion/verify   the code the person emailed back;
 *                                         a right one returns `confirmToken`
 *   POST /admin/account-deletion/delete   closes the account (confirmToken)
 *
 * The code proves the request came from whoever holds the phone, not just
 * whoever wrote the email. It is the in-app deletion code (ACCOUNT_DELETION),
 * with the same per-number limits, and closing runs `closeAccount`, the same
 * function as the in-app DELETE /me: what is deleted, kept and erased is
 * identical (services/auth/deleteAccount.ts).
 *
 * Refused for an admin's account (ADMIN, or a number on the allowlist) and,
 * like the app, while the person is on a ride.
 *
 * Every step writes an AdminAuditLog row ("account_deletion.*", and the
 * closing itself "account.delete" with the admin as actor): who, when, the
 * number masked, and what happened. Never the code, and never the full
 * number — the website promises the number is erased after the retention
 * period, and the audit log is kept for good.
 */

/**
 * How long the texted code stays valid. Longer than a login code's 5
 * minutes: it travels back by email, and an admin has to read it. Still
 * single-use, 5 wrong tries burn it, and only an admin can check it.
 */
export const EMAIL_DELETION_CODE_TTL_MINUTES = 30;

/** The text message: says what the code is for, and that it's meant to be sent back. */
export function emailDeletionSms(code: string): string {
  return (
    `CampusRide: to confirm deleting your account, reply to our email with this code: ${code}. ` +
    `It expires in ${EMAIL_DELETION_CODE_TTL_MINUTES} minutes. Didn't ask? Ignore this text.`
  );
}

const ADMIN_ACCOUNT = "Admin accounts can't be deleted here.";
const NO_ACCOUNT = "No account found for this number.";

const SCHEMAS = {
  lookup: { querystring: object({ phone: phoneField }, ["phone"]) },
  code: { body: object({ phone: phoneField }, ["phone"]) },
  verify: {
    body: object({ phone: phoneField, code: text(MAX.otpCode, { nonEmpty: true }) }, ["phone", "code"]),
  },
  delete: {
    body: object(
      { phone: phoneField, confirmToken: text(MAX.token, { nonEmpty: true }) },
      ["phone", "confirmToken"],
    ),
  },
};

/** The open account on a number: what the admin needs to recognise it, nothing more. */
async function openAccount(prisma: PrismaClient, phone: string) {
  return prisma.user.findFirst({
    where: { phone, deletedAt: null },
    select: { id: true, name: true, role: true, createdAt: true },
  });
}

type Account = NonNullable<Awaited<ReturnType<typeof openAccount>>>;

/** Why this account can't be deleted from here right now, if it can't. */
async function blockerFor(prisma: PrismaClient, phone: string, account: Account) {
  if (account.role === "ADMIN" || (await isAdminNumber(prisma, phone))) {
    return { reason: "admin" as const, message: ADMIN_ACCOUNT };
  }
  const ride = await findRideBlockingDeletion(prisma, account.id);
  if (ride) {
    return {
      reason: "active_ride" as const,
      message: new ActiveRideBlocksDeletionError(ride.id).message,
      rideId: ride.id,
    };
  }
  return null;
}

export function registerAdminAccountDeletionRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  otpService: OtpService,
): void {
  useRequestValidation(app);
  const gate = { onRequest: [requireAuth, adminOnly] };

  /** One audit row per step: the number masked, the outcome in words. */
  async function audit(
    request: FastifyRequest,
    step: string,
    phone: string,
    account: { id: string } | null,
    outcome: string,
  ) {
    await prisma.adminAuditLog.create({
      data: {
        actor: request.user!.userId,
        action: `account_deletion.${step}`,
        target: account?.id ?? maskPhone(phone),
        reason: `${maskPhone(phone)}: ${outcome}`.slice(0, 1000),
      },
    });
  }

  /** The canonical number from a body or query, or a 400 already sent. */
  function phoneFrom(raw: unknown, reply: FastifyReply): string | null {
    const phone = typeof raw === "string" ? normalizePhone(raw) : null;
    if (!phone) reply.code(400).send({ error: "phone must be a Ghanaian number" });
    return phone;
  }

  app.get("/admin/account-deletion", { ...gate, schema: SCHEMAS.lookup }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const phone = phoneFrom((request.query as { phone?: unknown }).phone, reply);
    if (!phone) return;

    const account = await openAccount(prisma, phone);
    const blocked = account ? await blockerFor(prisma, phone, account) : null;
    await audit(
      request,
      "lookup",
      phone,
      account,
      !account ? "no account" : blocked ? `found ${account.role}, ${blocked.reason}` : `found ${account.role}`,
    );
    return reply.send({
      phone,
      account: account && { ...account, createdAt: account.createdAt.toISOString() },
      blocked,
    });
  });

  app.post("/admin/account-deletion/code", { ...gate, schema: SCHEMAS.code }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const phone = phoneFrom((request.body as { phone?: unknown }).phone, reply);
    if (!phone) return;

    const account = await openAccount(prisma, phone);
    if (!account) {
      await audit(request, "code_refused", phone, null, "no account");
      return reply.code(404).send({ error: NO_ACCOUNT });
    }
    const blocked = await blockerFor(prisma, phone, account);
    if (blocked) {
      await audit(request, "code_refused", phone, account, blocked.reason);
      return reply
        .code(blocked.reason === "admin" ? 403 : 409)
        .send({ error: blocked.message, ...(blocked.rideId ? { rideId: blocked.rideId } : {}) });
    }

    try {
      await requestOtp(prisma, otpService, phone, "ACCOUNT_DELETION", new Date(), {
        ip: clientIpForLimits(request),
        ttlMinutes: EMAIL_DELETION_CODE_TTL_MINUTES,
        message: emailDeletionSms,
      });
    } catch (err) {
      if (err instanceof RateLimitedError) {
        await audit(request, "code_refused", phone, account, "rate limited");
        return sendRateLimited(reply, err.retryAfterMs);
      }
      throw err;
    }
    await audit(request, "code_sent", phone, account, "code texted");
    return reply.send({ sent: true, phone: maskPhone(phone), expiresInMinutes: EMAIL_DELETION_CODE_TTL_MINUTES });
  });

  app.post("/admin/account-deletion/verify", { ...gate, schema: SCHEMAS.verify }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { phone?: unknown; code?: unknown };
    const phone = phoneFrom(body.phone, reply);
    if (!phone) return;

    const account = await openAccount(prisma, phone);
    if (!account) {
      await audit(request, "verify", phone, null, "refused: no account");
      return reply.code(404).send({ error: NO_ACCOUNT });
    }
    if (account.role === "ADMIN" || (await isAdminNumber(prisma, phone))) {
      await audit(request, "verify", phone, account, "refused: admin");
      return reply.code(403).send({ error: ADMIN_ACCOUNT });
    }

    const refuse = async (outcome: string, error: string) => {
      await audit(request, "verify", phone, account, outcome);
      return reply.code(400).send({ error });
    };
    try {
      await verifyOtp(prisma, phone, String(body.code), "ACCOUNT_DELETION");
    } catch (err) {
      if (err instanceof RateLimitedError) {
        await audit(request, "verify", phone, account, "rate limited");
        return sendRateLimited(reply, err.retryAfterMs);
      }
      if (err instanceof InvalidOtpError) {
        return refuse("wrong code", "That code isn't right. Check what they emailed back, or send a new code.");
      }
      if (err instanceof OtpExpiredError) return refuse("code expired", "That code has expired. Send a new one.");
      if (err instanceof OtpAttemptsExceededError) {
        return refuse("too many wrong codes", "Too many wrong codes. Send a new one.");
      }
      throw err;
    }

    await audit(request, "verify", phone, account, "code correct");
    return reply.send({
      verified: true,
      confirmToken: signDeletionConfirmToken({ userId: account.id, phone, actor: request.user!.userId }),
      expiresInMinutes: TOKEN.VERIFICATION_TOKEN_TTL_MINUTES,
    });
  });

  app.post("/admin/account-deletion/delete", { ...gate, schema: SCHEMAS.delete }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { phone?: unknown; confirmToken?: unknown };
    const phone = phoneFrom(body.phone, reply);
    if (!phone) return;
    const actor = request.user!.userId;

    let userId: string;
    try {
      ({ userId } = verifyDeletionConfirmToken(String(body.confirmToken), { phone, actor }));
    } catch (err) {
      if (!(err instanceof InvalidVerificationTokenError)) throw err;
      await audit(request, "delete_refused", phone, null, "code not confirmed or confirmation expired");
      return reply.code(400).send({
        error: `The code check is only good for ${TOKEN.VERIFICATION_TOKEN_TTL_MINUTES} minutes. Send a new code.`,
      });
    }

    // The account the code was checked for, still open and still on this number.
    const account = await openAccount(prisma, phone);
    if (!account || account.id !== userId) {
      await audit(request, "delete_refused", phone, account, "no account");
      return reply.code(404).send({ error: "Account not found or already deleted" });
    }
    if (account.role === "ADMIN" || (await isAdminNumber(prisma, phone))) {
      await audit(request, "delete_refused", phone, account, "admin");
      return reply.code(403).send({ error: ADMIN_ACCOUNT });
    }

    let purgeAfter: Date;
    try {
      ({ purgeAfter } = await closeAccount(prisma, account.id, {
        actor,
        reason: `${maskPhone(phone)}: emailed request, confirmed with a texted code`,
      }));
    } catch (err) {
      if (err instanceof ActiveRideBlocksDeletionError) {
        await audit(request, "delete_refused", phone, account, "active_ride");
        return reply.code(409).send({ error: err.message, rideId: err.rideId });
      }
      if (err instanceof AccountAlreadyDeletedError) {
        await audit(request, "delete_refused", phone, account, "already deleted");
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }

    request.log.info(
      { userId: account.id, actor, event: "account_deleted" },
      "Account closed by an admin on an emailed request",
    );
    return reply.send({ deleted: true, role: account.role, erasedAfter: purgeAfter.toISOString() });
  });
}
