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
