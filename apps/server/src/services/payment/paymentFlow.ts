import type { PrismaClient, Payment } from "@prisma/client";
import { splitFare } from "@rida/shared";
import { isActivePassengerStatus } from "../ride/stateMachine";
import { isDefiniteFailure, isDefiniteSuccess, type MoolreChannel } from "./constants";
import { NoAwaitingOtpPaymentError, UnknownPaymentReferenceError } from "./errors";
import type { PaymentService } from "./PaymentService";

/**
 * Idempotency keys. Deterministic per ride/leg so retries (and webhook
 * redeliveries) never double-charge or double-pay — stored as
 * `Payment.providerRef` and checked before initiating anything.
 *
 * One deviation from the spec's example (`collect:{rideId}`): a SHARED ride
 * has multiple passengers, each charged individually, so collection refs are
 * per-passenger.
 */
export function collectionExternalRef(rideId: string, riderId: string): string {
  return `collect:${rideId}:${riderId}`;
}

/**
 * Per-rider disbursement ref (Phase 4c): the driver is paid in increments,
 * one per confirmed passenger collection, so each disbursement is keyed by
 * ride + driver + the specific rider whose fare it pays out.
 */
export function disbursementExternalRef(rideId: string, driverUserId: string, riderId: string): string {
  return `disburse:${rideId}:${driverUserId}:${riderId}`;
}

export interface CollectForRiderInput {
  rideId: string;
  riderId: string;
  /** Final fare for this passenger, in integer pesewas (RidePassenger.lockedFare, frozen at departure). */
  amountPesewas: number;
  payerPhone: string;
  channel: MoolreChannel;
  /** Present only on the OTP-confirmation (second) call — the code the rider entered. */
  otpcode?: string;
}

/**
 * Runs (or re-runs) the actual collect() call against an existing Payment row
 * and applies its outcome. Shared by the first call (payment just created,
 * status PENDING) and the OTP-confirmation call (payment already
 * AWAITING_OTP) — the transition logic is identical either way.
 */
async function runCollectAttempt(
  prisma: PrismaClient,
  paymentService: PaymentService,
  payment: Payment,
  input: CollectForRiderInput,
  externalRef: string,
): Promise<Payment> {
  try {
    const outcome = await paymentService.collect({
      rideId: input.rideId,
      payerPhone: input.payerPhone,
      channel: input.channel,
      amountPesewas: input.amountPesewas,
      externalRef,
      otpcode: input.otpcode,
    });

    if (outcome.kind === "OTP_REQUIRED") {
      if (payment.status !== "AWAITING_OTP") {
        return prisma.payment.update({ where: { id: payment.id }, data: { status: "AWAITING_OTP" } });
      }
      // Wrong code on a retry — stays AWAITING_OTP, no-op write.
      return payment;
    }

    // PROMPT_SENT — advance to PENDING (awaiting webhook confirmation), persist providerTxId if present.
    return prisma.payment.update({
      where: { id: payment.id },
      data: { status: "PENDING", ...(outcome.providerTxId ? { providerTxId: outcome.providerTxId } : {}) },
    });
  } catch (err) {
    // The provider call itself failed (e.g. auth rejection, duplicate ref) —
    // the Payment row must not be left stuck PENDING/AWAITING_OTP. Rethrown so
    // the error (with Moolre's code/message) stays visible in logs rather than swallowed.
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
    throw err;
  }
}

/**
 * Initiates (or confirms, or returns the existing) collection Payment row for
 * a single rider. Idempotent on `collectionExternalRef(rideId, riderId)`:
 *
 * - no existing row -> create one and call collect(). If otpcode is somehow
 *   present here (no row to confirm), throws NoAwaitingOtpPaymentError instead
 *   of creating a row and calling collect() with a stray otpcode.
 * - existing row + no otpcode -> genuine duplicate re-submit, return as-is
 *   (today's double-charge protection, unchanged).
 * - existing row + otpcode + status AWAITING_OTP -> OTP confirmation; bypasses
 *   the short-circuit above and re-calls collect() with the same externalRef.
 * - existing row + otpcode + any other status -> nothing to confirm, throws
 *   NoAwaitingOtpPaymentError. Never calls Moolre.
 */
export async function initiateCollection(
  prisma: PrismaClient,
  paymentService: PaymentService,
  input: CollectForRiderInput,
): Promise<Payment> {
  const externalRef = collectionExternalRef(input.rideId, input.riderId);

  const existing = await prisma.payment.findFirst({ where: { providerRef: externalRef } });

  if (existing) {
    if (!input.otpcode) {
      return existing;
    }
    if (existing.status !== "AWAITING_OTP") {
      throw new NoAwaitingOtpPaymentError(externalRef);
    }
    return runCollectAttempt(prisma, paymentService, existing, input, externalRef);
  }

  if (input.otpcode) {
    throw new NoAwaitingOtpPaymentError(externalRef);
  }

  const payment = await prisma.payment.create({
    data: {
      rideId: input.rideId,
      riderId: input.riderId,
      amount: input.amountPesewas,
      type: "COLLECTION",
      status: "PENDING",
      providerRef: externalRef,
    },
  });

  return runCollectAttempt(prisma, paymentService, payment, input, externalRef);
}

export interface RiderPayer {
  phone: string;
  channel: MoolreChannel;
}

/**
 * Default payer resolution for a rider: their account phone, MTN channel.
 * Riders don't yet choose a mobile-money network in the schema/profile flow
 * (same open item as `resolveDriverPayout` in routes/webhooks.ts) — flagged
 * in ROADMAP.md for a later phase.
 */
export async function resolveRiderPayer(prisma: PrismaClient, riderId: string): Promise<RiderPayer> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: riderId } });
  return { phone: user.phone, channel: "MTN" };
}

/**
 * Initiates a collection for every active (WAITING/PICKED_UP) passenger of a
 * ride, using their frozen `lockedFare` as the amount. Called from
 * `departRide` (ARRIVED -> IN_PROGRESS) once lockedFares are permanently
 * frozen — see assembly.ts.
 */
export async function initiateRideCollections(
  prisma: PrismaClient,
  paymentService: PaymentService,
  rideId: string,
  resolvePayer: (riderId: string) => RiderPayer | Promise<RiderPayer>,
): Promise<Payment[]> {
  const ride = await prisma.ride.findUniqueOrThrow({
    where: { id: rideId },
    include: { passengers: true },
  });

  const results: Payment[] = [];
  for (const passenger of ride.passengers) {
    if (!isActivePassengerStatus(passenger.status) || passenger.lockedFare == null) continue;

    const { phone, channel } = await resolvePayer(passenger.riderId);
    results.push(
      await initiateCollection(prisma, paymentService, {
        rideId: ride.id,
        riderId: passenger.riderId,
        amountPesewas: passenger.lockedFare,
        payerPhone: phone,
        channel,
      }),
    );
  }
  return results;
}

export interface MoolreWebhookPayload {
  txstatus: number;
  externalref: string;
  secret: string;
  [key: string]: unknown;
}

/**
 * Verifies the webhook `secret` against `expectedSecret`. This is the
 * security gate — without it, anyone could POST a fake "paid" callback and
 * trigger a driver disbursement for an uncollected ride.
 */
export function isValidWebhookSecret(payload: { secret?: unknown }, expectedSecret: string): boolean {
  return typeof payload.secret === "string" && payload.secret.length > 0 && payload.secret === expectedSecret;
}

export interface DisbursementRecipient {
  driverUserId: string;
  phone: string;
  channel: MoolreChannel;
}

export type PassengerPaymentStatus = "PENDING" | "COLLECTED" | "DISBURSED" | "FAILED";

export interface PassengerPaymentSummary {
  riderId: string;
  /** This passenger's frozen fare, in integer pesewas. */
  farePesewas: number;
  status: PassengerPaymentStatus;
  /** The driver's share paid out for this passenger's fare, 0 until DISBURSED. */
  disbursedPesewas: number;
}

export interface RidePaymentSummary {
  rideId: string;
  totalExpectedPesewas: number;
  totalCollectedPesewas: number;
  totalDisbursedPesewas: number;
  perPassenger: PassengerPaymentSummary[];
  /** True if any passenger's collection, or any disbursement, definitely failed. */
  hasFailures: boolean;
  /** True if every active passenger has been collected AND the driver paid out for each. */
  fullySettled: boolean;
}

/**
 * Derives the ride's payment state from `Payment` rows + frozen
 * `RidePassenger.lockedFare`s, independent of `Ride.status` /
 * `Ride.paymentStatus`. A COMPLETED ride can have PENDING or FAILED entries
 * here — that's intended (see decision #2/#3 in Phase 4c) and this summary is
 * how that state stays visible rather than orphaned.
 */
export async function getRidePaymentSummary(prisma: PrismaClient, rideId: string): Promise<RidePaymentSummary> {
  const ride = await prisma.ride.findUniqueOrThrow({
    where: { id: rideId },
    include: { passengers: true },
  });
  const payments = await prisma.payment.findMany({ where: { rideId } });

  // Billable = was actually carried (or still is), regardless of how far along
  // their per-passenger lifecycle is — WAITING/ARRIVED/PICKED_UP (mid-ride) and
  // DROPPED_OFF (finished their leg) all owe their locked fare. Only CANCELLED
  // passengers are excluded. This is deliberately broader than
  // isActivePassengerStatus (which means "still occupies a seat right now" and
  // excludes DROPPED_OFF) — using that here would make a SHARED ride's payment
  // summary go empty the moment everyone has been dropped off.
  const billablePassengers = ride.passengers.filter(
    (p) => p.status !== "CANCELLED" && p.lockedFare != null,
  );

  const perPassenger: PassengerPaymentSummary[] = billablePassengers.map((p) => {
    const collection = payments.find((pay) => pay.type === "COLLECTION" && pay.riderId === p.riderId);
    const disbursement = ride.driverId
      ? payments.find(
          (pay) => pay.type === "DISBURSEMENT" && pay.providerRef === disbursementExternalRef(rideId, ride.driverId!, p.riderId),
        )
      : undefined;

    let status: PassengerPaymentStatus;
    if (collection?.status === "FAILED") {
      status = "FAILED";
    } else if (disbursement?.status === "SUCCESS") {
      status = "DISBURSED";
    } else if (collection?.status === "SUCCESS") {
      status = "COLLECTED";
    } else {
      // TODO(3c): AWAITING_OTP currently buckets as PENDING here; surface it distinctly
      // when the UI needs poll-based OTP awareness.
      status = "PENDING";
    }

    return {
      riderId: p.riderId,
      farePesewas: p.lockedFare ?? 0,
      status,
      disbursedPesewas: disbursement?.status === "SUCCESS" ? disbursement.amount : 0,
    };
  });

  const totalExpectedPesewas = perPassenger.reduce((sum, p) => sum + p.farePesewas, 0);
  const totalCollectedPesewas = perPassenger
    .filter((p) => p.status === "COLLECTED" || p.status === "DISBURSED")
    .reduce((sum, p) => sum + p.farePesewas, 0);
  const totalDisbursedPesewas = perPassenger.reduce((sum, p) => sum + p.disbursedPesewas, 0);

  const hasFailedDisbursement = payments.some((pay) => pay.type === "DISBURSEMENT" && pay.status === "FAILED");
  const hasFailures = perPassenger.some((p) => p.status === "FAILED") || hasFailedDisbursement;
  const fullySettled = perPassenger.length > 0 && perPassenger.every((p) => p.status === "DISBURSED");

  return {
    rideId,
    totalExpectedPesewas,
    totalCollectedPesewas,
    totalDisbursedPesewas,
    perPassenger,
    hasFailures,
    fullySettled,
  };
}

/**
 * Recomputes and persists a coarse `Ride.paymentStatus` from
 * `getRidePaymentSummary`. This is a best-effort aggregate for quick
 * filtering — `getRidePaymentSummary` is the source of truth for per-rider
 * detail (e.g. one FAILED rider alongside otherwise-DISBURSED ones still
 * surfaces here as FAILED, but the summary shows exactly which rider).
 */
async function syncRidePaymentStatus(prisma: PrismaClient, rideId: string): Promise<void> {
  const summary = await getRidePaymentSummary(prisma, rideId);

  let paymentStatus: "PENDING" | "COLLECTED" | "DISBURSED" | "FAILED";
  if (summary.hasFailures) {
    paymentStatus = "FAILED";
  } else if (summary.fullySettled) {
    paymentStatus = "DISBURSED";
  } else if (summary.totalExpectedPesewas > 0 && summary.totalCollectedPesewas === summary.totalExpectedPesewas) {
    paymentStatus = "COLLECTED";
  } else {
    paymentStatus = "PENDING";
  }

  await prisma.ride.update({ where: { id: rideId }, data: { paymentStatus } });
}

/**
 * Handles a verified Moolre collection webhook for a single rider's
 * collection. Caller MUST verify `isValidWebhookSecret` before calling this.
 *
 * - txstatus FAILED (2): marks that Payment FAILED. The ride, driver, and
 *   other passengers are otherwise untouched — debt handling (retry/chasing)
 *   is out of scope for Phase 4c; the failure remains visible via
 *   `getRidePaymentSummary`. `Ride.paymentStatus` is resynced to FAILED as a
 *   coarse aggregate.
 * - txstatus SUCCESS (1): marks the Payment SUCCESS (idempotent — a
 *   redelivered webhook for an already-SUCCESS payment is a no-op), then
 *   IMMEDIATELY initiates disbursement of the driver's share of THIS rider's
 *   fare (per-rider, via `disbursementExternalRef(rideId, driverUserId, riderId)`).
 *   Marking the collection SUCCESS and creating the (PENDING) disbursement
 *   Payment row happens atomically in one transaction, so a crash between
 *   them can't leave a collected fare with no disbursement record. The
 *   actual provider disburse call follows outside the transaction — a
 *   failed disburse does NOT roll back the confirmed collection.
 * - txstatus PENDING (0) or UNKNOWN (3): no state change — these are not
 *   definite outcomes (see isDefiniteFailure/isDefiniteSuccess).
 *
 * Throws UnknownPaymentReferenceError if `externalref` doesn't match a
 * COLLECTION Payment row.
 */
export async function handleCollectionWebhook(
  prisma: PrismaClient,
  paymentService: PaymentService,
  payload: Pick<MoolreWebhookPayload, "txstatus" | "externalref">,
  resolveDriver: (driverUserId: string) => Promise<DisbursementRecipient>,
): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: { providerRef: payload.externalref, type: "COLLECTION" },
  });
  if (!payment) {
    throw new UnknownPaymentReferenceError(payload.externalref);
  }

  if (isDefiniteFailure(payload.txstatus)) {
    if (payment.status !== "FAILED") {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
    }
    await syncRidePaymentStatus(prisma, payment.rideId);
    return;
  }

  if (!isDefiniteSuccess(payload.txstatus)) {
    // PENDING or UNKNOWN — keep waiting.
    return;
  }

  if (payment.status === "SUCCESS") {
    // Already processed (e.g. redelivered webhook) — idempotent no-op.
    return;
  }

  const { driverId, disbursement, alreadyDisbursing } = await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS" } });

    const ride = await tx.ride.findUniqueOrThrow({ where: { id: payment.rideId } });
    if (!ride.driverId) {
      return { driverId: null as string | null, disbursement: null as Payment | null, alreadyDisbursing: false };
    }

    const disburseRef = disbursementExternalRef(payment.rideId, ride.driverId, payment.riderId);
    const existing = await tx.payment.findFirst({ where: { providerRef: disburseRef } });
    if (existing) {
      return { driverId: ride.driverId, disbursement: existing, alreadyDisbursing: true };
    }

    const { driverShare } = splitFare(payment.amount);
    const created = await tx.payment.create({
      data: {
        rideId: payment.rideId,
        riderId: ride.driverId,
        amount: driverShare,
        type: "DISBURSEMENT",
        status: "PENDING",
        providerRef: disburseRef,
      },
    });

    return { driverId: ride.driverId, disbursement: created, alreadyDisbursing: false };
  });

  if (driverId && disbursement && !alreadyDisbursing) {
    const recipient = await resolveDriver(driverId);
    await paymentService.validateRecipient({ phone: recipient.phone, channel: recipient.channel });

    const result = await paymentService.disburse({
      rideId: payment.rideId,
      recipientPhone: recipient.phone,
      channel: recipient.channel,
      amountPesewas: disbursement.amount,
      externalRef: disbursement.providerRef!,
    });

    if (isDefiniteFailure(result.txstatus)) {
      await prisma.payment.update({ where: { id: disbursement.id }, data: { status: "FAILED" } });
    } else if (isDefiniteSuccess(result.txstatus)) {
      await prisma.payment.update({ where: { id: disbursement.id }, data: { status: "SUCCESS" } });
    }
    // PENDING/UNKNOWN — disbursement Payment row stays PENDING for a later status check.
  }

  await syncRidePaymentStatus(prisma, payment.rideId);
}
