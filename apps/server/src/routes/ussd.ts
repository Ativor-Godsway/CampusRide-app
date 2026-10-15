import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { handleUssdRequest, type MoolreUssdRequest } from "../services/ussd/ussdHandler";
import { getSession } from "../services/ussd/session";
import { config } from "../config";
import { limiter } from "../rateLimit/limiter";
import { RULES } from "../rateLimit/rules";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Moolre's USSD callback's `new` field shows up as a real boolean, the
 * strings "true"/"false", or (confirmed against the real gateway) the
 * integer 1/0 or the strings "1"/"0". Only these explicit known shapes
 * coerce — deliberately NOT a blanket Boolean(value) cast, which would
 * silently accept any truthy garbage instead of falling through to the
 * session-presence inference below on an unauthenticated callback path.
 */
function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
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
export function registerUssdRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  enabled: boolean = config.enableUssd,
): void {
  // USSD is shelved for this launch (ENABLE_USSD defaults to false). The
  // callback is unauthenticated and, via findOrCreateRiderByPhone, will mint
  // a rider account for ANY msisdn with no verification — so while the flag
  // is off the route is not registered at all and Fastify 404s it. The
  // handler and services/ussd/* below are left untouched and dormant.
  if (!enabled) return;

  // Every callback comes from Moolre's gateway, so an IP limit would be one
  // bucket for every subscriber; the limit is per subscriber (msisdn) instead.
  // A Moolre gateway IP allowlist is still needed before switching USSD on.
  app.post("/ussd/callback", async (request, reply) => {
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

    const allowed = await limiter.consume([{ rule: RULES.ussd, subject: body.msisdn }]);
    if (!allowed.ok) {
      return reply.code(200).send({ message: "Too many requests. Please try again in a minute.", reply: false });
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
