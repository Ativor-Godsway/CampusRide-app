import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { handleUssdRequest, type MoolreUssdRequest } from "../services/ussd/ussdHandler";
import { getSession } from "../services/ussd/session";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Moolre's USSD callback arrives as application/x-www-form-urlencoded, where
 * every field is a string — `new=true` arrives as the literal string "true",
 * not a boolean. Accepts a real boolean (JSON callers, tests) or the
 * "true"/"false" strings form-urlencoded actually sends.
 */
function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Registers `POST /ussd/callback`.
 *
 * PUBLIC — no preHandler, matching the existing unauthenticated precedent in
 * webhooks.ts (`POST /webhooks/moolre`). Moolre has no way to send our JWT on
 * a USSD keypress callback, and (unlike the payment webhook) the documented
 * USSD callback payload carries no shared secret to verify either — there is
 * no signature/secret gate here. Deferred per the build plan; this endpoint
 * only ever creates REQUESTED rides and reads ride status, it never moves
 * money or mutates another rider's data.
 */
export function registerUssdRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.post("/ussd/callback", async (request, reply) => {
    // TEMPORARY — keep until we've confirmed Moolre's exact field
    // names/value types from Render logs, then remove.
    request.log.info({ body: request.body }, "[ussd] raw callback body");

    const body = request.body as {
      sessionId?: unknown;
      new?: unknown;
      msisdn?: unknown;
      message?: unknown;
    };

    if (
      !isNonEmptyString(body.sessionId) ||
      !isNonEmptyString(body.msisdn) ||
      typeof body.message !== "string"
    ) {
      // sessionId/msisdn/message have no sensible fallback if missing —
      // something upstream is broken, not a user input we can re-prompt.
      // End cleanly rather than throwing into Moolre's webhook caller.
      return reply.code(200).send({ message: "CampusRide is unavailable right now. Please try again later.", reply: false });
    }

    // `new` is the one field with a usable fallback: if it's missing or
    // doesn't coerce to a boolean, infer freshness from whether we already
    // have a session for this sessionId, rather than failing the whole
    // request to the unavailable message.
    const coercedNew = coerceBoolean(body.new);
    const isNew = coercedNew !== null ? coercedNew : getSession(body.sessionId) === undefined;

    const ussdRequest: MoolreUssdRequest = {
      sessionId: body.sessionId,
      new: isNew,
      msisdn: body.msisdn,
      message: body.message,
    };

    const response = await handleUssdRequest(prisma, ussdRequest);
    return reply.code(200).send(response);
  });
}
