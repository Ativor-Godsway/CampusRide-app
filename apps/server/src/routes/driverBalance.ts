import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { debtWarningText, paystackQuote, showsDebtWarning, blocksGoingOnline, warningLevelPesewas, type MomoNetwork } from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { requireAuth } from "../middleware/auth";
import { empty, object, oneOf, text } from "../http/schemas";
import { RULES } from "../rateLimit/rules";
import { config } from "../config";
import { driverBalance } from "../services/admin/cash";
import { getCommissionSettings } from "../services/commission/settings";
import { driverLedger } from "../services/commission/ledger";
import type { PaystackClient } from "../services/commission/paystack";
import {
  CommissionPaymentError,
  MIN_PAYMENT_PESEWAS,
  commissionPaymentStatus,
  handlePaystackWebhook,
  paymentView,
  startCommissionPayment,
  submitCommissionOtp,
  syncDriverPayments,
  type SyncedPayment,
} from "../services/commission/payments";

const referenceParams = object({ reference: text(100, { nonEmpty: true }) }, ["reference"]);

const SCHEMAS = {
  balance: { querystring: empty },
  start: {
    body: object(
      {
        channel: oneOf(["MOMO", "CHECKOUT"]),
        phone: text(30),
        network: oneOf(["MTN", "TELECEL", "AIRTELTIGO"]),
      },
      ["channel"],
    ),
  },
  status: { params: referenceParams, querystring: empty },
  // The parser below hands the handler `{}`; the signed raw body is read instead.
  webhook: { body: empty },
  otp: { params: referenceParams, body: object({ otp: text(20, { nonEmpty: true }) }, ["otp"]) },
};

/** What Paystack said when asked about a driver's payments: the reference and outcome only. */
function logChecks(log: FastifyBaseLogger, checked: readonly SyncedPayment[]) {
  for (const c of checked) {
    if (c.outcome === "skipped" || c.outcome === "not_paid") continue;
    const entry = { event: "commission_payment_checked", reference: c.reference, outcome: c.outcome };
    if (c.outcome === "mismatch") log.error(entry, "Paystack payment didn't match what was asked: not credited");
    else log.info(entry, "Commission payment checked with Paystack");
  }
}

function sendPaymentError(reply: FastifyReply, err: unknown) {
  if (err instanceof CommissionPaymentError) return reply.code(err.status).send({ error: err.message, code: err.code });
  throw err;
}

/**
 * The driver's commission balance and paying it through Paystack
 * (services/commission). Riders pay drivers in cash, so each cash trip
 * leaves the driver owing CampusRide 15%; the driver app's Balance screen
 * shows it and pays the whole balance (Paystack's fee added on top).
 *
 * POST /webhooks/paystack is Paystack telling us about a payment: only a
 * valid signature AND Paystack's verify endpoint ever credit one.
 */
export function registerDriverBalanceRoutes(app: FastifyInstance, prisma: PrismaClient, paystack: PaystackClient): void {
  useRequestValidation(app);

  const requireDriver = (request: { user?: { role?: string } }, reply: FastifyReply): boolean => {
    if (request.user?.role !== "DRIVER") {
      void reply.code(403).send({ error: "Driver role required" });
      return false;
    }
    return true;
  };

  /**
   * What the driver owes, the rules, what paying it would cost, a payment
   * still going, and the latest payment or waiver. Unfinished payments are
   * brought up to date with Paystack first (syncDriverPayments).
   */
  app.get("/driver/balance", { onRequest: requireAuth, schema: SCHEMAS.balance }, async (request, reply) => {
    if (!requireDriver(request, reply)) return;
    const userId = request.user!.userId;
    logChecks(request.log, await syncDriverPayments(prisma, paystack, userId));
    const [balance, settings, history, pending, lastCredit] = await Promise.all([
      driverBalance(prisma, userId),
      getCommissionSettings(prisma),
      driverLedger(prisma, userId),
      prisma.driverPaystackPayment.findFirst({ where: { driverUserId: userId, status: "PENDING" }, orderBy: { createdAt: "desc" } }),
      // A payment or waiver that still stands (not a reversal, not reversed).
      prisma.driverCashPayment.findFirst({
        where: { driverUserId: userId, kind: { in: ["PAYMENT", "WAIVER"] }, amountPesewas: { gt: 0 }, reversesId: null, reversal: { is: null } },
        orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
        select: { kind: true, amountPesewas: true, paidAt: true },
      }),
    ]);
    const owed = balance.balancePesewas;
    return reply.send({
      balancePesewas: owed,
      commissionPesewas: balance.owedPesewas,
      paidPesewas: balance.paidPesewas,
      waivedPesewas: balance.waivedPesewas,
      rules: {
        debtLimitPesewas: settings.debtLimitPesewas,
        warningPercent: settings.warningPercent,
        warningPesewas: warningLevelPesewas(settings),
        enforcementEnabled: settings.enforcementEnabled,
        feeBps: settings.feeBps,
        feeCapPesewas: settings.feeCapPesewas,
      },
      blocked: blocksGoingOnline(owed, settings),
      warning: showsDebtWarning(owed, settings) ? debtWarningText(owed, settings.debtLimitPesewas) : null,
      canPay: paystack.configured,
      minPaymentPesewas: MIN_PAYMENT_PESEWAS,
      quote: owed >= MIN_PAYMENT_PESEWAS ? paystackQuote(owed, settings.feeBps, settings.feeCapPesewas) : null,
      pendingPayment: pending ? paymentView(pending) : null,
      lastCredit: lastCredit
        ? { kind: lastCredit.kind as "PAYMENT" | "WAIVER", amountPesewas: lastCredit.amountPesewas, at: lastCredit.paidAt.toISOString() }
        : null,
      // Driver builds before 2026-11-09's redesign list it on Balance; newer ones don't.
      history: history.map(({ note: _note, recordedBy: _by, ...entry }) => entry),
    });
  });

  /** Starts paying the whole balance: MoMo (approve on the phone) or Paystack's checkout page. */
  app.post(
    "/driver/balance/payments",
    { onRequest: requireAuth, schema: SCHEMAS.start, config: { limits: { user: [RULES.commissionPay] } } },
    async (request, reply) => {
      if (!requireDriver(request, reply)) return;
      const body = request.body as { channel: "MOMO" | "CHECKOUT"; phone?: string; network?: MomoNetwork };
      if (body.channel === "MOMO" && (!body.phone || !body.network)) {
        return reply.code(400).send({ error: "Enter your MoMo number and choose its network.", code: "MOMO_DETAILS_REQUIRED" });
      }
      try {
        const payment = await startCommissionPayment(
          prisma,
          paystack,
          body.channel === "MOMO"
            ? { driverUserId: request.user!.userId, channel: "MOMO", phone: body.phone!, network: body.network! }
            : { driverUserId: request.user!.userId, channel: "CHECKOUT" },
        );
        // The reference and outcome only: never the phone number.
        request.log.info({ event: "commission_payment_started", reference: payment.reference, status: payment.status, channel: payment.channel }, "Commission payment started");
        return reply.code(201).send({ payment });
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    },
  );

  /** One of the driver's own payments, as it stands now (asks Paystack while it's unfinished). */
  app.get("/driver/balance/payments/:reference", { onRequest: requireAuth, schema: SCHEMAS.status }, async (request, reply) => {
    if (!requireDriver(request, reply)) return;
    try {
      const { payment, checked } = await commissionPaymentStatus(prisma, paystack, request.user!.userId, (request.params as { reference: string }).reference);
      logChecks(request.log, checked);
      return reply.send({ payment });
    } catch (err) {
      return sendPaymentError(reply, err);
    }
  });

  /** The code a network asked for (Telecel's voucher, an OTP). */
  app.post(
    "/driver/balance/payments/:reference/otp",
    { onRequest: requireAuth, schema: SCHEMAS.otp, config: { limits: { user: [RULES.commissionPay] } } },
    async (request, reply) => {
      if (!requireDriver(request, reply)) return;
      try {
        const payment = await submitCommissionOtp(
          prisma,
          paystack,
          request.user!.userId,
          (request.params as { reference: string }).reference,
          (request.body as { otp: string }).otp,
        );
        return reply.send({ payment });
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    },
  );

  // The webhook needs the exact bytes Paystack signed, so it has its own
  // JSON parser (scoped to this plugin) that keeps the raw body. The body
  // itself is only read after the signature checks out.
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      (request as unknown as { rawBody: string }).rawBody = body as string;
      done(null, {});
    });
    scope.post("/webhooks/paystack", { schema: SCHEMAS.webhook }, async (request, reply) => {
      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";
      const result = await handlePaystackWebhook(prisma, paystack, config.paystack.secretKey, rawBody, request.headers["x-paystack-signature"]);
      if (result.status === 401) request.log.warn({ event: "paystack_webhook_bad_signature" }, "Paystack webhook with a bad signature refused");
      if (result.outcome === "mismatch") {
        request.log.error({ event: "paystack_amount_mismatch", reference: result.reference }, "Paystack payment didn't match what was asked: not credited");
      } else if (result.outcome) {
        request.log.info({ event: "paystack_webhook", reference: result.reference, outcome: result.outcome }, "Paystack webhook handled");
      }
      return reply.code(result.status).send(result.body);
    });
  });
}
