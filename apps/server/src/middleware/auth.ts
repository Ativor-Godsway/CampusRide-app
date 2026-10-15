import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db/prisma";
import { verifyAccessToken, type AccessTokenPayload } from "../services/auth/tokens";
import { loadActiveAccount } from "../services/auth/accountStatus";
import { adminPhoneAllowed } from "../services/auth/adminAccess";
import { config } from "../config";
import { isDevLoopbackExempt } from "../lib/security";
import { limiter } from "../rateLimit/limiter";
import { RULES } from "../rateLimit/rules";
import { clientIpForLimits, sendRateLimited } from "../rateLimit/reply";

declare module "fastify" {
  interface FastifyRequest {
    user?: AccessTokenPayload;
  }
}

const INVALID_TOKEN = "Invalid or expired access token";

/**
 * A refused token counts toward the caller's IP backstop, exactly like a
 * request to a public route: someone hammering signed-in routes with junk
 * tokens is bounded, while a real user's occasional expired token (the app
 * refreshes it and retries) is nowhere near the limit.
 */
async function refuse(request: FastifyRequest, reply: FastifyReply, error: string): Promise<void> {
  const ip = isDevLoopbackExempt(request.ip, config.nodeEnv) ? null : clientIpForLimits(request);
  if (ip) {
    const outcome = await limiter.consume([{ rule: RULES.ipPublic, subject: ip }]);
    if (!outcome.ok) {
      sendRateLimited(reply, outcome.retryAfterMs);
      return;
    }
  }
  reply.code(401).send({ error });
}

/**
 * Fastify preHandler that validates the `Authorization: Bearer <token>`
 * access token and attaches the caller as `request.user`. Replies 401 and
 * short-circuits the handler if the header is missing, the token is invalid,
 * expired or not an access token, or the account has since been deleted.
 *
 * `request.user.role` is the account's role in the database right now, not
 * the one written into the token (see services/auth/accountStatus.ts).
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return refuse(request, reply, "Missing or invalid Authorization header");
  }

  const token = header.slice("Bearer ".length);

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return refuse(request, reply, INVALID_TOKEN);
  }

  // Same answer as a bad token: a deleted account looks exactly like an
  // expired session, and the app's refresh then fails and signs it out.
  const account = await loadActiveAccount(prisma, payload.userId);
  if (!account) {
    return refuse(request, reply, INVALID_TOKEN);
  }

  request.user = { userId: account.userId, role: account.role };
}

/**
 * Gate for the admin surface, mirroring `requireDriver` in routes/driver.ts:
 * run it as the FIRST line of a handler that already has `requireAuth` as
 * its preHandler, and bail when it returns false.
 *
 *   app.post("/admin/...", { preHandler: requireAuth }, async (req, reply) => {
 *     if (!(await requireAdmin(req, reply))) return;
 *
 * Two keys, both needed: the account's role is ADMIN in the database, AND
 * its phone is on ADMIN_PHONE_ALLOWLIST (services/auth/adminAccess.ts). A
 * number that isn't on the list gets the same 403 as a rider, so the list's
 * existence isn't confirmed.
 *
 * ADMIN is never self-assignable: POST /auth/signup only accepts
 * RIDER|DRIVER (see SignupRole), so the only way an account gets this role
 * is src/scripts/seedAdmin.ts, run by hand against the database.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const userId = request.user?.userId;
  const account = userId && request.user?.role === "ADMIN" ? await loadActiveAccount(prisma, userId) : null;
  if (!account || account.role !== "ADMIN" || !adminPhoneAllowed(account.phone)) {
    if (account?.role === "ADMIN") {
      request.log.warn({ event: "admin_not_allowlisted", userId }, "ADMIN account refused: phone not on ADMIN_PHONE_ALLOWLIST");
    }
    reply.code(403).send({ error: "Admin role required" });
    return false;
  }
  return true;
}
