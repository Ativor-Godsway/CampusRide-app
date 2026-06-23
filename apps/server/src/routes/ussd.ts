import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { handleUssdRequest, type MoolreUssdRequest } from "../services/ussd/ussdHandler";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
    const body = request.body as {
      sessionId?: unknown;
      new?: unknown;
      msisdn?: unknown;
      message?: unknown;
    };

    if (
      !isNonEmptyString(body.sessionId) ||
      typeof body.new !== "boolean" ||
      !isNonEmptyString(body.msisdn) ||
      typeof body.message !== "string"
    ) {
      // Moolre always sends this shape; a malformed request means something
      // upstream is broken, not a user input we can re-prompt. End cleanly
      // rather than throwing into Moolre's webhook caller.
      return reply.code(200).send({ message: "CampusRide is unavailable right now. Please try again later.", reply: false });
    }

    const ussdRequest: MoolreUssdRequest = {
      sessionId: body.sessionId,
      new: body.new,
      msisdn: body.msisdn,
      message: body.message,
    };

    const response = await handleUssdRequest(prisma, ussdRequest);
    return reply.code(200).send(response);
  });
}
