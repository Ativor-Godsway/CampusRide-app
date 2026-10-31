import type { FastifyInstance, FastifyRequest } from "fastify";
import { useRequestValidation } from "../http/validation";
import type { PrismaClient } from "@prisma/client";
import { OTP_COOLDOWN_LIMIT, otpCooldownMessage, rateLimitedBody } from "@rida/shared";
import type { OtpService } from "../services/otp/OtpService";
import { requestOtp, verifyOtp } from "../services/auth/otp";
import { signVerificationToken } from "../services/auth/tokens";
import {
  completeDriverProfile,
  login,
  logout,
  refresh,
  signup,
  type SignupRole,
} from "../services/auth/authService";
import {
  AdminNotAllowedError,
  AdminPasskeyRequiredError,
  AdminSessionEndedError,
  NotAnAdminError,
  InvalidOtpError,
  InvalidRefreshTokenError,
  InvalidVerificationTokenError,
  RefreshTokenReuseError,
  OtpAttemptsExceededError,
  OtpExpiredError,
  PhoneAlreadyRegisteredError,
  TermsNotConfirmedError,
  UserNotFoundError,
} from "../services/auth/errors";
import { requireAuth } from "../middleware/auth";
import { meSelect } from "./selects";
import { termsConfirmation } from "../services/auth/terms";
import { InvalidEmergencyContactError, updateRiderProfile } from "../services/auth/profile";
import {
  AccountAlreadyDeletedError,
  ActiveRideBlocksDeletionError,
  closeAccount,
  findRideBlockingDeletion,
} from "../services/auth/deleteAccount";
import { maskPhone } from "../lib/redact";
import { config } from "../config";
import { isValidDriverPhotoUrl } from "../services/uploads/cloudinarySignature";
import { normalizePhone } from "../lib/phone";
import { RateLimitedError, enforce } from "../rateLimit/limiter";
import { RULES } from "../rateLimit/rules";
import { clientIpForLimits, sendRateLimited } from "../rateLimit/reply";
import { isAdminSiteRequest, recordAdminLogin, type AdminLoginFailure } from "../services/admin/loginAudit";
import { adminNeedsPasskey } from "../services/auth/passkeys";
import { MAX, boolean, bodyOptional, empty, noInput, object, oneOf, phone as phoneField, text } from "../http/schemas";


const OTP_PURPOSES = ["SIGNUP", "LOGIN"] as const;
const SIGNUP_ROLES = ["RIDER", "DRIVER"] as const;

const purpose = oneOf(OTP_PURPOSES);
const verifiedToken = text(MAX.token, { nonEmpty: true });
const refreshToken = text(MAX.token, { nonEmpty: true });

/** Request schemas (http/schemas.ts): unknown fields are dropped before the handler. */
const SCHEMAS = {
  requestOtp: { body: object({ phone: phoneField, purpose }, ["phone", "purpose"]) },
  verifyOtp: {
    body: object({ phone: phoneField, code: text(MAX.otpCode, { nonEmpty: true }), purpose }, ["phone", "code", "purpose"]),
  },
  verifyCode: {
    body: object({ phone: phoneField, code: text(MAX.otpCode, { nonEmpty: true }) }, ["phone", "code"]),
  },
  signup: {
    body: object(
      {
        phone: phoneField,
        name: text(MAX.name, { nonEmpty: true }),
        role: oneOf(SIGNUP_ROLES),
        verifiedToken,
        // Required, but checked in the handler so the refusal reads as a sentence.
        ageAndTermsConfirmed: boolean,
      },
      ["phone", "name", "role", "verifiedToken"],
    ),
  },
  login: { body: object({ phone: phoneField, verifiedToken }, ["phone", "verifiedToken"]) },
  refresh: { body: object({ refreshToken }, ["refreshToken"]) },
  logout: { body: object({ refreshToken, pushToken: text(MAX.pushToken) }, ["refreshToken"]) },
  me: noInput,
  patchMe: {
    body: object({
      name: text(MAX.name),
      emergencyContactName: text(MAX.name, { nullable: true }),
      emergencyContactPhone: text(MAX.phone, { nullable: true }),
    }),
  },
  confirmTerms: { querystring: empty, body: object({ ageAndTermsConfirmed: boolean }) },
  deletionCode: { querystring: empty, body: empty },
  deleteMe: { querystring: empty, body: object({ code: text(MAX.otpCode) }) },
  driverProfile: {
    body: object(
      {
        carMake: text(MAX.vehicleField, { nonEmpty: true }),
        carModel: text(MAX.vehicleField, { nonEmpty: true }),
        carColor: text(MAX.vehicleField, { nonEmpty: true }),
        plate: text(MAX.plate, { nonEmpty: true }),
        photoUrl: text(MAX.url),
      },
      ["carMake", "carModel", "carColor", "plate"],
    ),
  },
};

function isOtpPurpose(value: unknown): value is (typeof OTP_PURPOSES)[number] {
  return typeof value === "string" && (OTP_PURPOSES as readonly string[]).includes(value);
}

function isSignupRole(value: unknown): value is SignupRole {
  return typeof value === "string" && (SIGNUP_ROLES as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * PHONE CANONICALIZATION. Every route below keys on the phone string:
 * OtpCode.phone, User.phone, and the signed verification token whose payload
 * verifyVerificationToken compares byte-for-byte. They must all agree on ONE
 * spelling, or a code requested as "0548608146" cannot be verified as
 * "+233548608146", and a token minted by one endpoint is rejected by the next.
 *
 * So each handler runs `normalizePhone` on the way in and passes only the
 * canonical "+233XXXXXXXXX" downstream — nothing below this layer, including
 * the database, ever sees a local or bare-msisdn form. A number that does not
 * normalize is a 400 here rather than a row nobody can log into later.
 */
const PHONE_NOT_GHANAIAN = "phone is not a valid Ghanaian number";

export function registerAuthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  otpService: OtpService,
): void {
  useRequestValidation(app);
  /**
   * Whether this login step goes in the admin sign-in record (see
   * services/admin/loginAudit.ts): it came from the admin site, or it is
   * about an admin's number — on the allowlist, or an ADMIN account's —
   * whichever app sent it.
   */
  async function adminLoginWatch(request: FastifyRequest, phone: string) {
    const user = await prisma.user.findUnique({ where: { phone }, select: { id: true, role: true, deletedAt: true } });
    const account = user && !user.deletedAt ? user : null;
    const watched =
      isAdminSiteRequest(request) || config.adminPhoneAllowlist.phones.includes(phone) || account?.role === "ADMIN";
    const record = (outcome: "code_sent" | "failure" | "success", reason?: AdminLoginFailure) =>
      watched ? recordAdminLogin(prisma, request, { outcome, phone, userId: account?.id ?? null, reason }) : Promise.resolve();
    return { record, adminId: account?.role === "ADMIN" ? account.id : null };
  }

  /**
   * Rate limits on these public routes are per PHONE NUMBER (services/auth/otp.ts,
   * and login.15m below), never per IP: a hostel on one Wi-Fi is one IP. The
   * per-IP backstop (rateLimit/http.ts) sits behind them, far higher.
   */
  app.post("/auth/request-otp", { schema: SCHEMAS.requestOtp }, async (request, reply) => {
    const body = request.body as { phone?: unknown; purpose?: unknown };

    if (!isNonEmptyString(body.phone) || !isOtpPurpose(body.purpose)) {
      return reply.code(400).send({ error: "phone and purpose (SIGNUP|LOGIN) are required" });
    }

    const phone = normalizePhone(body.phone);
    if (!phone) {
      return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
    }

    const watch = await adminLoginWatch(request, phone);
    // An admin with a passkey signs in with it (ADMIN_OTP_FALLBACK off): no
    // code is sent that couldn't be used.
    if (watch.adminId && (await adminNeedsPasskey(prisma, watch.adminId))) {
      const refused = new AdminPasskeyRequiredError(watch.adminId);
      await watch.record("failure", "passkey_required");
      return reply.code(403).send({ error: refused.message, code: refused.code });
    }
    try {
      await requestOtp(prisma, otpService, phone, body.purpose, new Date(), { ip: clientIpForLimits(request) });
      await watch.record("code_sent");
      return reply.code(200).send({ ok: true });
    } catch (err) {
      if (err instanceof RateLimitedError) {
        await watch.record("failure", "rate_limited");
        // Only the one-a-minute cooldown: a code went out moments ago (often
        // this person's own "Send code" that timed out, then went through).
        // Said as a short wait, and marked so the app opens the code screen.
        if (err.rule.name === RULES.otpCooldown.name) {
          const body = rateLimitedBody(err.retryAfterMs / 1000);
          return reply
            .code(429)
            .header("retry-after", String(body.retryAfterSeconds))
            .send({ ...body, error: otpCooldownMessage(body.retryAfterSeconds), limit: OTP_COOLDOWN_LIMIT });
        }
        return sendRateLimited(reply, err.retryAfterMs);
      }
      throw err;
    }
  });

  app.post("/auth/verify-otp", { schema: SCHEMAS.verifyOtp }, async (request, reply) => {
    const body = request.body as { phone?: unknown; code?: unknown; purpose?: unknown };

    if (
      !isNonEmptyString(body.phone) ||
      !isNonEmptyString(body.code) ||
      !isOtpPurpose(body.purpose)
    ) {
      return reply.code(400).send({ error: "phone, code, and purpose (SIGNUP|LOGIN) are required" });
    }

    const phone = normalizePhone(body.phone);
    if (!phone) {
      return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
    }
    const watch = await adminLoginWatch(request, phone);

    try {
      const result = await verifyOtp(prisma, phone, body.code, body.purpose);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        await watch.record("failure", "rate_limited");
        return sendRateLimited(reply, err.retryAfterMs);
      }
      if (err instanceof InvalidOtpError) await watch.record("failure", "bad_code");
      if (err instanceof OtpExpiredError) await watch.record("failure", "code_expired");
      if (err instanceof OtpAttemptsExceededError) await watch.record("failure", "too_many_attempts");
      if (
        err instanceof InvalidOtpError ||
        err instanceof OtpExpiredError ||
        err instanceof OtpAttemptsExceededError
      ) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * ONE PHONE ENTRY (the apps from 2026-10): the person types their number,
   * gets a code, and only then learns whether they have an account.
   *
   * The code is asked for with /auth/request-otp, purpose LOGIN, which never
   * looks the number up: its answer, timing and limits are the same for a
   * registered number and a new one. So nothing before the right code says
   * whether a number is registered. Then this route checks the code (the
   * same limits and attempt counting as /auth/verify-otp) and:
   *
   * - an open account: signs in, answering as /auth/login does, plus
   *   `status: "signedIn"`;
   * - no account (or a deleted one): `status: "newAccount"` and a SIGNUP
   *   verifiedToken, which /auth/signup takes for the name + 18+ step.
   *
   * /auth/verify-otp, /auth/login and /auth/signup stay as they are for older
   * app versions and the admin site.
   */
  app.post("/auth/verify-code", { schema: SCHEMAS.verifyCode }, async (request, reply) => {
    const body = request.body as { phone?: unknown; code?: unknown };
    if (!isNonEmptyString(body.phone) || !isNonEmptyString(body.code)) {
      return reply.code(400).send({ error: "phone and code are required" });
    }
    const phone = normalizePhone(body.phone);
    if (!phone) {
      return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
    }
    const watch = await adminLoginWatch(request, phone);

    try {
      const { verifiedToken: loginToken } = await verifyOtp(prisma, phone, body.code, "LOGIN");
      try {
        await enforce([{ rule: RULES.login15m, subject: phone }]);
        const result = await login(prisma, {
          phone,
          verifiedToken: loginToken,
          adminSite: isAdminSiteRequest(request),
        });
        await watch.record("success");
        return reply.code(200).send({ status: "signedIn", ...result });
      } catch (err) {
        if (err instanceof UserNotFoundError) {
          // The code proved the number; the account doesn't exist yet.
          return reply.code(200).send({
            status: "newAccount",
            verifiedToken: signVerificationToken({ phone, purpose: "SIGNUP" }),
          });
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof RateLimitedError) {
        await watch.record("failure", "rate_limited");
        return sendRateLimited(reply, err.retryAfterMs);
      }
      if (err instanceof InvalidOtpError) await watch.record("failure", "bad_code");
      if (err instanceof OtpExpiredError) await watch.record("failure", "code_expired");
      if (err instanceof OtpAttemptsExceededError) await watch.record("failure", "too_many_attempts");
      if (
        err instanceof InvalidOtpError ||
        err instanceof OtpExpiredError ||
        err instanceof OtpAttemptsExceededError
      ) {
        return reply.code(400).send({ error: err.message });
      }
      if (err instanceof AdminNotAllowedError) {
        await watch.record("failure", "not_allowlisted");
        request.log.warn({ event: "admin_login_not_allowlisted", userId: err.userId }, "ADMIN login refused: not on ADMIN_PHONE_ALLOWLIST");
        return reply.code(403).send({ error: err.message, code: "ADMIN_NOT_ALLOWED" });
      }
      if (err instanceof AdminPasskeyRequiredError) {
        await watch.record("failure", "passkey_required");
        return reply.code(403).send({ error: err.message, code: err.code });
      }
      if (err instanceof NotAnAdminError) {
        await watch.record("failure", "not_admin");
        return reply.code(403).send({ error: err.message, code: "NOT_AN_ADMIN" });
      }
      throw err;
    }
  });

  app.post("/auth/signup", { schema: SCHEMAS.signup }, async (request, reply) => {
    const body = request.body as {
      phone?: unknown;
      name?: unknown;
      role?: unknown;
      verifiedToken?: unknown;
      ageAndTermsConfirmed?: unknown;
    };

    if (
      !isNonEmptyString(body.phone) ||
      !isNonEmptyString(body.name) ||
      !isSignupRole(body.role) ||
      !isNonEmptyString(body.verifiedToken)
    ) {
      return reply
        .code(400)
        .send({ error: "phone, name, role (RIDER|DRIVER), and verifiedToken are required" });
    }

    // "I'm 18 or older and I agree to the Terms and Privacy Policy": no
    // account without it, whatever the app did or didn't show (an old build
    // that never asks gets told to update).
    if (body.ageAndTermsConfirmed !== true) {
      return reply.code(400).send({ error: new TermsNotConfirmedError().message, code: "TERMS_NOT_CONFIRMED" });
    }

    const phone = normalizePhone(body.phone);
    if (!phone) {
      return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
    }

    try {
      await enforce([{ rule: RULES.login15m, subject: phone }]);
      const result = await signup(prisma, {
        phone,
        name: body.name,
        role: body.role,
        verifiedToken: body.verifiedToken,
        ageAndTermsConfirmed: true,
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof RateLimitedError) return sendRateLimited(reply, err.retryAfterMs);
      if (err instanceof InvalidVerificationTokenError) {
        return reply.code(401).send({ error: err.message });
      }
      if (err instanceof PhoneAlreadyRegisteredError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/login", { schema: SCHEMAS.login }, async (request, reply) => {
    const body = request.body as { phone?: unknown; verifiedToken?: unknown };

    if (!isNonEmptyString(body.phone) || !isNonEmptyString(body.verifiedToken)) {
      return reply.code(400).send({ error: "phone and verifiedToken are required" });
    }

    const phone = normalizePhone(body.phone);
    if (!phone) {
      return reply.code(400).send({ error: PHONE_NOT_GHANAIAN });
    }

    const watch = await adminLoginWatch(request, phone);
    try {
      await enforce([{ rule: RULES.login15m, subject: phone }]);
      const result = await login(prisma, {
        phone,
        verifiedToken: body.verifiedToken,
        adminSite: isAdminSiteRequest(request),
      });
      await watch.record("success");
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        await watch.record("failure", "rate_limited");
        return sendRateLimited(reply, err.retryAfterMs);
      }
      if (err instanceof InvalidVerificationTokenError) {
        await watch.record("failure", "invalid_verification");
        return reply.code(401).send({ error: err.message });
      }
      if (err instanceof UserNotFoundError) {
        await watch.record("failure", "no_account");
        return reply.code(404).send({ error: err.message });
      }
      if (err instanceof AdminNotAllowedError) {
        await watch.record("failure", "not_allowlisted");
        request.log.warn({ event: "admin_login_not_allowlisted", userId: err.userId }, "ADMIN login refused: not on ADMIN_PHONE_ALLOWLIST");
        return reply.code(403).send({ error: err.message, code: "ADMIN_NOT_ALLOWED" });
      }
      if (err instanceof AdminPasskeyRequiredError) {
        await watch.record("failure", "passkey_required");
        return reply.code(403).send({ error: err.message, code: err.code });
      }
      if (err instanceof NotAnAdminError) {
        await watch.record("failure", "not_admin");
        return reply.code(403).send({ error: err.message, code: "NOT_AN_ADMIN" });
      }
      throw err;
    }
  });

  app.post("/auth/refresh", { schema: SCHEMAS.refresh }, async (request, reply) => {
    const body = request.body as { refreshToken?: unknown };

    if (!isNonEmptyString(body.refreshToken)) {
      return reply.code(400).send({ error: "refreshToken is required" });
    }

    try {
      const result = await refresh(prisma, body.refreshToken);
      return reply.code(200).send(result);
    } catch (err) {
      // Per login and per account (authService.refresh). 429 is never read as
      // a dead session by the apps, so nobody is signed out by it.
      if (err instanceof RateLimitedError) return sendRateLimited(reply, err.retryAfterMs);
      if (err instanceof AdminSessionEndedError) {
        request.log.info(
          { event: "admin_session_ended", userId: err.userId, reason: err.reason },
          "Admin session ended; a new sign-in is needed",
        );
        return reply.code(401).send({ error: err.message, code: "ADMIN_SESSION_ENDED" });
      }
      if (err instanceof RefreshTokenReuseError) {
        // Every token in this login's rotation chain has just been revoked.
        // Log it as the security event it is — but answer EXACTLY as for any
        // other invalid token (same status, same message), so an attacker
        // learns nothing about whether they tripped the detector.
        request.log.warn(
          { userId: err.userId, event: "refresh_token_reuse" },
          "Refresh token reuse detected — revoked the entire token family",
        );
        return reply.code(401).send({ error: err.message });
      }
      if (err instanceof InvalidRefreshTokenError) {
        return reply.code(401).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/logout", { schema: SCHEMAS.logout }, async (request, reply) => {
    const body = request.body as { refreshToken?: unknown; pushToken?: unknown };

    if (!isNonEmptyString(body.refreshToken)) {
      return reply.code(400).send({ error: "refreshToken is required" });
    }

    try {
      // Optional pushToken: this install's push token, deleted with the session.
      const pushToken = isNonEmptyString(body.pushToken) ? body.pushToken : undefined;
      await logout(prisma, body.refreshToken, new Date(), pushToken);
      return reply.code(200).send({ ok: true });
    } catch (err) {
      if (err instanceof InvalidRefreshTokenError) {
        return reply.code(401).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/me", { onRequest: requireAuth, schema: SCHEMAS.me }, async (request, reply) => {
    // Explicit select (routes/selects.ts) so a future User column is not
    // published to clients just by existing.
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: meSelect,
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.code(200).send({ user });
  });

  /**
   * Partial profile update for the signed-in user — the rider-side mirror of
   * PATCH /driver/profile. Handles the display name and the single emergency
   * contact used by POST /rides/:id/sos.
   *
   * `phone` is not updatable here: it is the login identity, so changing it
   * needs a fresh OTP verification of the new number (its own flow, not this
   * one).
   */
  app.patch(
    "/me",
    { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.patchMe, config: { limits: { user: [RULES.profile] } } },
    async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: unknown;
      emergencyContactName?: unknown;
      emergencyContactPhone?: unknown;
    };

    // `null` is meaningful for the contact fields — it CLEARS them — so it is
    // accepted, while any other non-string is a client bug.
    const input: {
      name?: string;
      emergencyContactName?: string | null;
      emergencyContactPhone?: string | null;
    } = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        return reply.code(400).send({ error: "name must be a string" });
      }
      input.name = body.name;
    }
    for (const field of ["emergencyContactName", "emergencyContactPhone"] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (value !== null && typeof value !== "string") {
        return reply.code(400).send({ error: `${field} must be a string or null` });
      }
      input[field] = value;
    }

    try {
      await updateRiderProfile(prisma, request.user!.userId, input);
    } catch (err) {
      if (err instanceof InvalidEmergencyContactError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    // Return the same shape as GET /me so the client can swap it straight in.
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: meSelect,
    });
    return reply.code(200).send({ user });
  });

  /**
   * "I'm 18 or older and I agree to the Terms and Privacy Policy", for an
   * account from before sign-up asked: the apps show it once, and won't go on
   * until it's confirmed here (or the person logs out or deletes the
   * account). Confirming again just records the current terms version.
   * Answers with the same shape as GET /me.
   */
  app.post(
    "/me/terms",
    { onRequest: requireAuth, schema: SCHEMAS.confirmTerms, config: { limits: { user: [RULES.profile] } } },
    async (request, reply) => {
      const { ageAndTermsConfirmed } = (request.body ?? {}) as { ageAndTermsConfirmed?: unknown };
      if (ageAndTermsConfirmed !== true) {
        return reply.code(400).send({ error: "ageAndTermsConfirmed must be true", code: "TERMS_NOT_CONFIRMED" });
      }
      const user = await prisma.user.update({
        where: { id: request.user!.userId },
        data: termsConfirmation(),
        select: meSelect,
      });
      return reply.code(200).send({ user });
    },
  );

  /**
   * In-app account deletion (an app-store requirement), in two calls from the
   * app's Delete account screen:
   *
   *   POST   /me/deletion-code  texts a code to the account's own phone
   *   DELETE /me { code }       checks it and closes the account
   *
   * Both refuse with 409 and a plain sentence while a ride is going on. What
   * closing does, and what is kept for how long: services/auth/deleteAccount.ts.
   */
  app.post(
    "/me/deletion-code",
    { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.deletionCode, config: { limits: { user: [RULES.accountDelete] } } },
    async (request, reply) => {
      const userId = request.user!.userId;
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true, deletedAt: true } });
      if (!user || user.deletedAt) return reply.code(404).send({ error: "Account not found or already deleted" });
      const ride = await findRideBlockingDeletion(prisma, userId);
      if (ride) return reply.code(409).send({ error: new ActiveRideBlocksDeletionError(ride.id).message, rideId: ride.id });
      try {
        await requestOtp(prisma, otpService, user.phone, "ACCOUNT_DELETION", new Date(), { ip: clientIpForLimits(request) });
      } catch (err) {
        if (err instanceof RateLimitedError) return sendRateLimited(reply, err.retryAfterMs);
        throw err;
      }
      // Enough of the number to recognise it, as the screen says where the code went.
      return reply.code(200).send({ sent: true, phone: maskPhone(user.phone) });
    },
  );

  app.delete(
    "/me",
    { onRequest: requireAuth, preValidation: bodyOptional, schema: SCHEMAS.deleteMe, config: { limits: { user: [RULES.accountDelete] } } },
    async (request, reply) => {
      const userId = request.user!.userId;
      const { code } = request.body as { code?: string };
      if (!code) {
        // An app from before the confirmation step: it has to be updated first.
        return reply.code(400).send({ error: "Enter the code we texted you to confirm. If you don't see where, update the app." });
      }
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true, deletedAt: true } });
      if (!user || user.deletedAt) return reply.code(404).send({ error: "Account not found or already deleted" });

      let purgeAfter: Date;
      try {
        await verifyOtp(prisma, user.phone, code, "ACCOUNT_DELETION");
        ({ purgeAfter } = await closeAccount(prisma, userId));
      } catch (err) {
        if (err instanceof RateLimitedError) return sendRateLimited(reply, err.retryAfterMs);
        if (err instanceof InvalidOtpError) {
          return reply.code(400).send({ error: "That code isn't right. Check the text message and try again." });
        }
        if (err instanceof OtpExpiredError) {
          return reply.code(400).send({ error: "That code has expired. Send a new one." });
        }
        if (err instanceof OtpAttemptsExceededError) {
          return reply.code(400).send({ error: "Too many wrong codes. Send a new one." });
        }
        if (err instanceof ActiveRideBlocksDeletionError) {
          return reply.code(409).send({ error: err.message, rideId: err.rideId });
        }
        if (err instanceof AccountAlreadyDeletedError) return reply.code(404).send({ error: err.message });
        throw err;
      }

      request.log.info({ userId, event: "account_deleted" }, "Account closed on the user's request");
      return reply.code(200).send({ deleted: true, erasedAfter: purgeAfter.toISOString() });
    },
  );

  app.post(
    "/driver/profile",
    { onRequest: requireAuth, schema: SCHEMAS.driverProfile, config: { limits: { user: [RULES.profile] } } },
    async (request, reply) => {
    const body = request.body as {
      carMake?: unknown;
      carModel?: unknown;
      carColor?: unknown;
      plate?: unknown;
      photoUrl?: unknown;
    };

    if (
      !isNonEmptyString(body.carMake) ||
      !isNonEmptyString(body.carModel) ||
      !isNonEmptyString(body.carColor) ||
      !isNonEmptyString(body.plate)
    ) {
      return reply
        .code(400)
        .send({ error: "carMake, carModel, carColor, and plate are required" });
    }

    if (request.user!.role !== "DRIVER") {
      return reply.code(403).send({ error: "Only DRIVER accounts have a driver profile" });
    }

    const userId = request.user!.userId;
    const photoUrl = isNonEmptyString(body.photoUrl) ? body.photoUrl.trim() : undefined;

    // Same check as PATCH /driver/profile: a photo must be this driver's own
    // upload to our Cloudinary account, not any URL on the internet. Skipped
    // when Cloudinary is unconfigured, so local dev can still onboard.
    const { cloudName } = config.cloudinary;
    if (photoUrl !== undefined && cloudName && !isValidDriverPhotoUrl(photoUrl, cloudName, userId)) {
      request.log.warn(
        { event: "driver_profile_save_failed", reason: "invalid_photo_url", userId, photoUrl },
        "Driver onboarding refused: photoUrl is not this driver's Cloudinary upload",
      );
      return reply.code(400).send({
        error: "photoUrl must be an image uploaded through this app",
        code: "INVALID_PHOTO_URL",
      });
    }

    let driver;
    try {
      driver = await completeDriverProfile(prisma, userId, {
        carMake: body.carMake.trim(),
        carModel: body.carModel.trim(),
        carColor: body.carColor.trim(),
        plate: body.plate.trim().toUpperCase(),
        ...(photoUrl !== undefined ? { photoUrl } : {}),
      });
    } catch (err) {
      // P2025: no Driver row for this user (e.g. the account was deleted).
      if ((err as { code?: string }).code === "P2025") {
        request.log.warn(
          { event: "driver_profile_save_failed", reason: "driver_row_missing", userId },
          "Driver onboarding refused: no driver profile exists for this account",
        );
        return reply.code(404).send({ error: "Driver profile not found", code: "DRIVER_NOT_FOUND" });
      }
      throw err;
    }

    request.log.info(
      { event: "driver_profile_saved", userId, hasPhoto: photoUrl !== undefined },
      "Driver onboarding profile saved",
    );
    return reply.code(200).send({ driver });
  });
}
