import { randomBytes } from "node:crypto";
import { Prisma, type DriverPaystackPayment, type PrismaClient } from "@prisma/client";
import { paystackQuote, type MomoNetwork } from "@rida/shared";
import { normalizePhone } from "../../lib/phone";
import { clearAdminCache } from "../admin/cache";
import { getCommissionSettings } from "./settings";
import { isValidPaystackSignature, type ChargeAnswer, type PaystackClient } from "./paystack";

/**
 * A driver paying their whole commission balance through Paystack
 * (docs/admin-metrics.md, "Cash owed").
 *
 * - The amount is LOCKED when the payment starts (DriverPaystackPayment
 *   .owedPesewas). Commission from a trip that ends meanwhile stays owed; only
 *   the locked amount is cleared.
 * - Nothing the app says counts. A payment is credited only after Paystack's
 *   verify endpoint says "success" for our reference, in GHS, for exactly
 *   the amount asked (gross). The webhook and the app's status checks both
 *   end in confirmCommissionPayment, which writes the PAYMENT row at most
 *   once per reference (a conditional update plus a unique column).
 * - A charge Paystack refuses outright falls back to its hosted checkout
 *   page (a new reference), opened in the browser.
 */

export class CommissionPaymentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CommissionPaymentError";
  }
}

/** Smaller balances wait for the next one (Paystack won't charge tiny amounts). */
export const MIN_PAYMENT_PESEWAS = 100;
/** A second "Pay" this soon after one still going returns that one (a double tap). */
const DUPLICATE_START_MS = 15_000;
/** An unfinished payment older than this is given up. */
const PENDING_GIVE_UP_MS = 30 * 60_000;
/** A charge Paystack has never heard of, this long after it started, never started. */
const NOT_FOUND_GIVE_UP_MS = 2 * 60_000;
/** Status checks ask Paystack at most this often per payment. */
const CHECK_EVERY_MS = 4_000;

/** Who recorded a PAYMENT row Paystack confirmed (DriverCashPayment.recordedBy). */
export const PAYSTACK_RECORDER = "paystack";

const lastChecked = new Map<string, number>();

/** Paystack needs an email; drivers have none, so a per-driver address on a domain that takes no mail. */
function receiptEmail(driverUserId: string): string {
  return `${driverUserId}@drivers.campusride.app`;
}

function newReference(): string {
  return `CRC-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

export interface CommissionPaymentView {
  reference: string;
  status: DriverPaystackPayment["status"];
  channel: "MOMO" | "CHECKOUT";
  owedPesewas: number;
  feePesewas: number;
  grossPesewas: number;
  momoNetwork: MomoNetwork | null;
  phoneLast4: string | null;
  /** The network asked for a code (Telecel's voucher, an OTP): POST it to …/otp. */
  needsOtp: boolean;
  /** What to tell the driver: Paystack's instruction, or why it failed. */
  message: string | null;
  /** The hosted checkout page to open, while it can still be paid. */
  checkoutUrl: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export function paymentView(row: DriverPaystackPayment): CommissionPaymentView {
  return {
    reference: row.reference,
    status: row.status,
    channel: row.channel === "CHECKOUT" ? "CHECKOUT" : "MOMO",
    owedPesewas: row.owedPesewas,
    feePesewas: row.feePesewas,
    grossPesewas: row.grossPesewas,
    momoNetwork: row.momoNetwork,
    phoneLast4: row.phoneLast4,
    needsOtp: row.status === "PENDING" && row.paystackStatus === "send_otp",
    message: row.message,
    checkoutUrl: row.status === "PENDING" ? row.checkoutUrl : null,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}

/** The driver's balance now, in SQL (commission − everything credited). */
async function balanceIn(tx: Prisma.TransactionClient, driverUserId: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ owed: bigint | null; credited: bigint | null }>>`
    SELECT (SELECT SUM("amountPesewas") FROM "CommissionLedger" WHERE "driverUserId" = ${driverUserId}) AS owed,
           (SELECT SUM("amountPesewas") FROM "DriverCashPayment" WHERE "driverUserId" = ${driverUserId}) AS credited`;
  return Number(row?.owed ?? 0) - Number(row?.credited ?? 0);
}

export type StartInput =
  | { driverUserId: string; channel: "MOMO"; phone: string; network: MomoNetwork }
  | { driverUserId: string; channel: "CHECKOUT" };

/**
 * Starts paying the whole balance. Answers the payment as it stands: usually
 * PENDING with what to do next (approve on the phone, enter a code, or open
 * the checkout page).
 */
export async function startCommissionPayment(
  prisma: PrismaClient,
  client: PaystackClient,
  input: StartInput,
  now: Date = new Date(),
): Promise<CommissionPaymentView> {
  if (!client.configured) {
    throw new CommissionPaymentError("PAYMENTS_UNAVAILABLE", "Paying in the app isn't available yet. Pay CampusRide in person for now.", 503);
  }
  let localPhone: string | null = null;
  if (input.channel === "MOMO") {
    const canonical = normalizePhone(input.phone);
    if (!canonical) throw new CommissionPaymentError("INVALID_PHONE", "Enter a Ghana mobile money number, like 024 123 4567.", 400);
    localPhone = `0${canonical.slice(-9)}`;
  }

  // Payments still going: a double tap gets the same one back; older ones
  // are checked with Paystack (one may have been paid) and otherwise given up.
  const pending = await prisma.driverPaystackPayment.findMany({
    where: { driverUserId: input.driverUserId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  const recent = pending.find((p) => now.getTime() - p.createdAt.getTime() < DUPLICATE_START_MS);
  if (recent) return paymentView(recent);
  for (const p of pending) {
    if ((await confirmCommissionPayment(prisma, client, p.reference, now)) === "credited") {
      return paymentView(await prisma.driverPaystackPayment.findUniqueOrThrow({ where: { id: p.id } }));
    }
    await prisma.driverPaystackPayment.updateMany({
      where: { id: p.id, status: "PENDING" },
      data: { status: "ABANDONED", message: "Replaced by a newer payment." },
    });
  }

  const settings = await getCommissionSettings(prisma);
  const created = await prisma.$transaction(async (tx) => {
    // One start at a time per driver: the balance is locked under this.
    await tx.$queryRaw`SELECT 1 FROM "Driver" WHERE "userId" = ${input.driverUserId} FOR UPDATE`;
    const balance = await balanceIn(tx, input.driverUserId);
    if (balance <= 0) throw new CommissionPaymentError("NOTHING_OWED", "You don't owe anything right now.", 409);
    if (balance < MIN_PAYMENT_PESEWAS) {
      throw new CommissionPaymentError("TOO_SMALL", "Balances under GH₵1 are paid with your next trips' commission.", 409);
    }
    const quote = paystackQuote(balance, settings.feeBps, settings.feeCapPesewas);
    return tx.driverPaystackPayment.create({
      data: {
        driverUserId: input.driverUserId,
        reference: newReference(),
        channel: input.channel,
        owedPesewas: quote.owedPesewas,
        feePesewas: quote.feePesewas,
        grossPesewas: quote.grossPesewas,
        feeBps: settings.feeBps,
        feeCapPesewas: settings.feeCapPesewas,
        momoNetwork: input.channel === "MOMO" ? input.network : null,
        phoneLast4: localPhone ? localPhone.slice(-4) : null,
        message: "Waiting for payment…",
      },
    });
  });

  if (input.channel === "CHECKOUT") return openCheckout(prisma, client, created);

  const answer = await client.chargeMomo({
    reference: created.reference,
    amountPesewas: created.grossPesewas,
    email: receiptEmail(input.driverUserId),
    phone: localPhone!,
    network: input.network,
  });
  if (answer.kind === "refused") {
    // The charge API can't take this one: Paystack's own page instead, as a new payment of the same amount.
    await prisma.driverPaystackPayment.update({
      where: { id: created.id },
      data: { status: "FAILED", message: answer.message },
    });
    const fallback = await prisma.driverPaystackPayment.create({
      data: {
        driverUserId: created.driverUserId,
        reference: newReference(),
        channel: "CHECKOUT",
        owedPesewas: created.owedPesewas,
        feePesewas: created.feePesewas,
        grossPesewas: created.grossPesewas,
        feeBps: created.feeBps,
        feeCapPesewas: created.feeCapPesewas,
        message: "Waiting for payment…",
      },
    });
    return openCheckout(prisma, client, fallback);
  }
  return applyChargeAnswer(prisma, client, created, answer, now);
}

async function openCheckout(prisma: PrismaClient, client: PaystackClient, row: DriverPaystackPayment): Promise<CommissionPaymentView> {
  const answer = await client.initializeCheckout({ reference: row.reference, amountPesewas: row.grossPesewas, email: receiptEmail(row.driverUserId) });
  const updated = await prisma.driverPaystackPayment.update({
    where: { id: row.id },
    data:
      answer.kind === "created"
        ? { checkoutUrl: answer.url, message: "Finish paying on the Paystack page, then come back here." }
        : {
            status: "FAILED",
            message: answer.kind === "refused" ? answer.message : "Couldn't reach Paystack. Check your connection and try again.",
          },
  });
  return paymentView(updated);
}

/** What a charge or OTP answer means for the payment. */
async function applyChargeAnswer(
  prisma: PrismaClient,
  client: PaystackClient,
  row: DriverPaystackPayment,
  answer: ChargeAnswer,
  now: Date,
): Promise<CommissionPaymentView> {
  if (answer.kind === "unreachable") {
    // It may have started: the status checks ask Paystack's verify endpoint.
    const updated = await prisma.driverPaystackPayment.update({
      where: { id: row.id },
      data: { message: "Waiting for Paystack… If your phone asks you to approve, approve it." },
    });
    return paymentView(updated);
  }
  if (answer.kind === "refused") {
    const updated = await prisma.driverPaystackPayment.update({ where: { id: row.id }, data: { status: "FAILED", message: answer.message } });
    return paymentView(updated);
  }
  if (answer.status === "success") {
    await confirmCommissionPayment(prisma, client, row.reference, now);
    return paymentView(await prisma.driverPaystackPayment.findUniqueOrThrow({ where: { id: row.id } }));
  }
  const failed = answer.status === "failed";
  const message = failed
    ? (answer.message ?? "The payment didn't go through. Try again.")
    : answer.status === "send_otp"
      ? (answer.message ?? "Enter the code sent to your phone.")
      : answer.status === "pay_offline"
        ? (answer.message ?? "Approve the payment on your phone. A prompt should appear in a few seconds.")
        : (answer.message ?? "Waiting for payment…");
  const updated = await prisma.driverPaystackPayment.update({
    where: { id: row.id },
    data: { status: failed ? "FAILED" : "PENDING", paystackStatus: answer.status.slice(0, 40), message: message.slice(0, 300) },
  });
  return paymentView(updated);
}

async function ownPayment(prisma: PrismaClient, driverUserId: string, reference: string): Promise<DriverPaystackPayment> {
  const row = await prisma.driverPaystackPayment.findUnique({ where: { reference } });
  // Another driver's reference is answered exactly like one that doesn't exist.
  if (!row || row.driverUserId !== driverUserId) throw new CommissionPaymentError("PAYMENT_NOT_FOUND", "Payment not found", 404);
  return row;
}

/** Sends the code a network asked for (Telecel's voucher, an OTP). */
export async function submitCommissionOtp(
  prisma: PrismaClient,
  client: PaystackClient,
  driverUserId: string,
  reference: string,
  otp: string,
  now: Date = new Date(),
): Promise<CommissionPaymentView> {
  const row = await ownPayment(prisma, driverUserId, reference);
  if (row.status !== "PENDING" || row.paystackStatus !== "send_otp") {
    throw new CommissionPaymentError("NO_CODE_NEEDED", "This payment isn't waiting for a code.", 409);
  }
  return applyChargeAnswer(prisma, client, row, await client.submitOtp(reference, otp.trim()), now);
}

/**
 * The payment as it stands, for the app's "Waiting for payment…" screen.
 * While it is unfinished this asks Paystack's verify endpoint (at most every
 * few seconds), so a payment is confirmed even if the webhook is late.
 */
export async function commissionPaymentStatus(
  prisma: PrismaClient,
  client: PaystackClient,
  driverUserId: string,
  reference: string,
  now: Date = new Date(),
): Promise<CommissionPaymentView> {
  const row = await ownPayment(prisma, driverUserId, reference);
  if (row.status !== "PENDING") return paymentView(row);
  const last = lastChecked.get(reference) ?? 0;
  if (now.getTime() - last >= CHECK_EVERY_MS) {
    lastChecked.set(reference, now.getTime());
    if (lastChecked.size > 5_000) lastChecked.clear();
    const outcome = await confirmCommissionPayment(prisma, client, reference, now);
    const age = now.getTime() - row.createdAt.getTime();
    if (outcome === "not_found" && age > NOT_FOUND_GIVE_UP_MS) {
      await giveUp(prisma, row.id, "FAILED", "The payment didn't start. Try again.");
    } else if ((outcome === "not_paid" || outcome === "not_found") && age > PENDING_GIVE_UP_MS) {
      await giveUp(prisma, row.id, "ABANDONED", "This payment wasn't finished. Start again when you're ready.");
    }
  }
  return paymentView(await prisma.driverPaystackPayment.findUniqueOrThrow({ where: { id: row.id } }));
}

async function giveUp(prisma: PrismaClient, id: string, status: "FAILED" | "ABANDONED", message: string) {
  await prisma.driverPaystackPayment.updateMany({ where: { id, status: "PENDING" }, data: { status, message } });
}

export type ConfirmOutcome =
  /** Verified and the PAYMENT row written now. */
  | "credited"
  /** Already credited before (a repeat webhook or check). */
  | "already"
  /** Paystack says it isn't paid (yet, or it failed). */
  | "not_paid"
  | "not_found"
  /** Paystack says paid, but not what was asked: never credited by itself. */
  | "mismatch"
  /** Not one of ours. */
  | "unknown"
  | "unreachable";

/**
 * Asks Paystack's verify endpoint about one of our references and, if it was
 * paid exactly as asked, credits the locked amount — once.
 */
export async function confirmCommissionPayment(
  prisma: PrismaClient,
  client: PaystackClient,
  reference: string,
  now: Date = new Date(),
): Promise<ConfirmOutcome> {
  const row = await prisma.driverPaystackPayment.findUnique({ where: { reference } });
  if (!row) return "unknown";
  if (row.status === "SUCCESS") return "already";
  if (row.status === "MISMATCH") return "mismatch";

  const v = await client.verify(reference);
  if (v.kind === "unreachable") return "unreachable";
  if (v.kind === "not_found") return "not_found";
  if (v.status !== "success") {
    if ((v.status === "failed" || v.status === "reversed") && row.status === "PENDING") {
      await giveUp(prisma, row.id, "FAILED", v.message ?? "The payment didn't go through. Try again.");
    }
    return "not_paid";
  }
  if (v.reference !== reference || v.currency !== "GHS" || v.amountPesewas !== row.grossPesewas) {
    await prisma.driverPaystackPayment.update({
      where: { id: row.id },
      data: {
        status: "MISMATCH",
        paystackStatus: "success",
        message: `Paystack reports ${v.amountPesewas} ${v.currency || "?"} for ${v.reference || "?"}; ${row.grossPesewas} GHS was asked. Not credited: CampusRide will check it.`.slice(0, 300),
      },
    });
    return "mismatch";
  }

  try {
    const credited = await prisma.$transaction(async (tx) => {
      const moved = await tx.driverPaystackPayment.updateMany({
        where: { id: row.id, status: { in: ["PENDING", "FAILED", "ABANDONED"] } },
        data: {
          status: "SUCCESS",
          paystackStatus: "success",
          confirmedAt: now,
          paystackFeePesewas: v.feesPesewas,
          message: null,
          checkoutUrl: null,
        },
      });
      if (moved.count === 0) return false;
      await tx.driverCashPayment.create({
        data: {
          driverUserId: row.driverUserId,
          kind: "PAYMENT",
          amountPesewas: row.owedPesewas,
          method: "PAYSTACK",
          note: `Paystack ${reference}`,
          paidAt: v.paidAt ?? now,
          recordedBy: PAYSTACK_RECORDER,
          paystackPaymentId: row.id,
        },
      });
      return true;
    });
    if (!credited) return "already";
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "already";
    throw err;
  }
  lastChecked.delete(reference);
  clearAdminCache();
  return "credited";
}

export type WebhookResult = { status: number; body: Record<string, unknown>; outcome?: ConfirmOutcome; reference?: string };

/**
 * POST /webhooks/paystack. The signature (HMAC-SHA512 of the raw body with
 * the secret key) is checked first; then, for charge.success, Paystack's
 * verify endpoint decides (confirmCommissionPayment). Every other event is
 * acknowledged and ignored. 5xx only when Paystack couldn't be asked, so
 * Paystack sends it again.
 */
export async function handlePaystackWebhook(
  prisma: PrismaClient,
  client: PaystackClient,
  secretKey: string,
  rawBody: string,
  signature: unknown,
): Promise<WebhookResult> {
  if (!secretKey) return { status: 503, body: { error: "Paystack is not set up" } };
  if (!isValidPaystackSignature(rawBody, signature, secretKey)) return { status: 401, body: { error: "Invalid signature" } };
  let event: { event?: unknown; data?: { reference?: unknown } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } };
  }
  if (event.event !== "charge.success" || typeof event.data?.reference !== "string") {
    return { status: 200, body: { received: true } };
  }
  const reference = event.data.reference.slice(0, 100);
  const outcome = await confirmCommissionPayment(prisma, client, reference);
  if (outcome === "unreachable") return { status: 502, body: { error: "Couldn't verify with Paystack" }, outcome, reference };
  return { status: 200, body: { received: true }, outcome, reference };
}

/** Forgets the status-check throttle (tests). */
export function resetPaymentChecksForTests(): void {
  lastChecked.clear();
}
