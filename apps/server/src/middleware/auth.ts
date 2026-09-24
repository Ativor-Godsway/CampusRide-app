import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken, type AccessTokenPayload } from "../services/auth/tokens";

declare module "fastify" {
  interface FastifyRequest {
    user?: AccessTokenPayload;
  }
}

/**
 * Fastify preHandler that validates the `Authorization: Bearer <token>`
 * access token and attaches the decoded payload as `request.user`. Replies
 * 401 and short-circuits the handler if the header is missing or the token
 * is invalid/expired.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice("Bearer ".length);

  try {
    request.user = verifyAccessToken(token);
  } catch {
    reply.code(401).send({ error: "Invalid or expired access token" });
  }
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
 * RIDER|DRIVER (see SignupRole), so the only way a token can carry this role
 * is src/scripts/seedAdmin.ts, run by hand against the database.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (request.user?.role !== "ADMIN") {
    reply.code(403).send({ error: "Admin role required" });
    return false;
  }
  return true;
}
