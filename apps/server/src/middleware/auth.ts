import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db/prisma";
import { verifyAccessToken, type AccessTokenPayload } from "../services/auth/tokens";
import { loadActiveAccount } from "../services/auth/accountStatus";

declare module "fastify" {
  interface FastifyRequest {
    user?: AccessTokenPayload;
  }
}

const INVALID_TOKEN = "Invalid or expired access token";

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
    reply.code(401).send({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice("Bearer ".length);

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    reply.code(401).send({ error: INVALID_TOKEN });
    return;
  }

  // Same answer as a bad token: a deleted account looks exactly like an
  // expired session, and the app's refresh then fails and signs it out.
  const account = await loadActiveAccount(prisma, payload.userId);
  if (!account) {
    reply.code(401).send({ error: INVALID_TOKEN });
    return;
  }

  request.user = { userId: account.userId, role: account.role };
}

/**
 * Role gate for the admin surface, mirroring `requireDriver` in
 * routes/driver.ts: run it as the FIRST line of a handler that already has
 * `requireAuth` as its preHandler, and bail when it returns false.
 *
 *   app.post("/admin/...", { preHandler: requireAuth }, async (req, reply) => {
 *     if (!(await requireAdmin(req, reply))) return;
 *
 * ADMIN is never self-assignable: POST /auth/signup only accepts
 * RIDER|DRIVER (see SignupRole), so the only way an account gets this role
 * is src/scripts/seedAdmin.ts, run by hand against the database.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (request.user?.role !== "ADMIN") {
    reply.code(403).send({ error: "Admin role required" });
    return false;
  }
  return true;
}
