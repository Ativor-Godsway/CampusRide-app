import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { PaymentService } from "../services/payment/PaymentService";
import {
  handleCollectionWebhook,
  isValidWebhookSecret,
  type DisbursementRecipient,
} from "../services/payment/paymentFlow";
import { UnknownPaymentReferenceError } from "../services/payment/errors";
import { config } from "../config";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Resolves the driver's payout phone/channel for a disbursement. Driver
 * payout channel selection (e.g. MTN/Telecel/AT) is not yet captured
 * anywhere in the schema or driver-profile flow, so we default to the
 * driver's account phone and MTN. Flagged in ROADMAP.md as an open item for
 * Phase 4b/5 (let drivers choose their payout network).
 */
async function resolveDriverPayout(prisma: PrismaClient, driverUserId: string): Promise<DisbursementRecipient> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: driverUserId } });
  return { driverUserId, phone: user.phone, channel: "MTN" };
}

/**
 * Registers `POST /webhooks/moolre`.
 *
 * SECURITY GATE: Moolre webhooks include a `secret` in `data`, which MUST
 * equal `MOOLRE_WEBHOOK_SECRET`. Missing or mismatched secrets are rejected
 * with 401 and never trusted — without this check, anyone could POST a fake
 * "paid" callback and trigger a driver disbursement for an uncollected ride.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  paymentService: PaymentService,
  webhookSecret: string,
  enabled: boolean = config.moolre.paymentsEnabled,
): void {
  // Cash-only lockdown (Phase 1): with Moolre disabled there is no collection
  // this webhook could legitimately resolve, and an open callback that can
  // flip payments to COLLECTED / trigger a disbursement is pure attack
  // surface. Leave the route unregistered entirely so Fastify 404s it — the
  // handler below (and the Moolre integration it drives) stays intact and
  // comes back the moment MOOLRE_ENABLED flips to "true".
  if (!enabled) return;

  app.post("/webhooks/moolre", async (request, reply) => {
    // NB: never log `request.body` here — the payload carries the shared
    // webhook secret in `data.secret`, so dumping it puts a credential that
    // authorizes driver disbursements into the log stream (and into any log
    // aggregator downstream). Log outcomes, not payloads.
    const body = request.body as { data?: Record<string, unknown> };
    const data = body.data;

    if (!data || !isValidWebhookSecret(data, webhookSecret)) {
      return reply.code(401).send({ error: "Invalid or missing webhook secret" });
    }

    if (!isFiniteNumber(data.txstatus) || !isNonEmptyString(data.externalref)) {
      return reply.code(400).send({ error: "txstatus and externalref are required" });
    }

    try {
      await handleCollectionWebhook(
        prisma,
        paymentService,
        { txstatus: data.txstatus, externalref: data.externalref },
        (driverUserId) => resolveDriverPayout(prisma, driverUserId),
      );
    } catch (err) {
      if (err instanceof UnknownPaymentReferenceError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }

    return reply.code(200).send({ ok: true });
  });
}
