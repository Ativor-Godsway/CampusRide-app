import type { CashPaymentMethod, PrismaClient } from "@prisma/client";
import { clearAdminCache } from "./cache";

/**
 * Cash owed (docs/admin-metrics.md). Riders pay drivers in cash; a driver
 * owes CampusRide the 15% recorded on each completed cash ride
 * (CommissionLedger.amountPesewas, stored at completion from the fares the
 * riders actually paid — never worked out again from today's prices).
 * What takes it off is a DriverCashPayment row: a payment (an admin records
 * cash handed over, or Paystack confirms one made in the driver app), a
 * waiver or an adjustment.
 *
 *   balance = Σ CommissionLedger.amountPesewas − Σ DriverCashPayment.amountPesewas
 *
 * A cancelled ride has no ledger row, so it owes nothing. Rows are never
 * edited or deleted: a reversal is a new row with the negative amount.
 */

export interface DriverBalance {
  driverUserId: string;
  /** All-time commission on completed cash rides at the rate then, waived trips included. */
  earnedPesewas: number;
  /** Of that, on trips completed while commission was waived: never owed. */
  commissionWaivedPesewas: number;
  /** Charged: commission on trips not waived (what could ever be owed). */
  owedPesewas: number;
  /** All-time payments (in person and Paystack), reversals taken off. */
  paidPesewas: number;
  /**
   * Balance waivers that actually forgave something: a waiver only counts up
   * to what the driver owed when it was given (a launch "waive all" over
   * trips that were later waived anyway forgives nothing twice).
   */
  waivedPesewas: number;
  /** All-time adjustments. */
  adjustedPesewas: number;
  /** charged − paid − waived − adjusted. Positive: still owed; negative: paid ahead. */
  balancePesewas: number;
  /** When the oldest commission not yet covered was recorded; null when nothing is owed. */
  oldestUnpaidAt: Date | null;
}

/**
 * The reconciliation every money page uses, per driver and in total:
 *
 *   earned = paid + waived (trips + balances) + adjusted + still owed − paid ahead
 */
export function reconciles(b: Pick<DriverBalance, "earnedPesewas" | "commissionWaivedPesewas" | "paidPesewas" | "waivedPesewas" | "adjustedPesewas" | "balancePesewas">): boolean {
  return b.earnedPesewas === b.paidPesewas + b.commissionWaivedPesewas + b.waivedPesewas + b.adjustedPesewas + b.balancePesewas;
}

type Ledgerish = Pick<PrismaClient, "commissionLedger" | "driverCashPayment">;

interface Charge {
  at: Date;
  amount: number;
}
interface Credit {
  id: string;
  at: Date;
  kind: "PAYMENT" | "WAIVER" | "ADJUSTMENT";
  amount: number;
  reversesId: string | null;
  createdAt: Date;
}

/**
 * One driver's balance from their charges and credits, in time order. Payments
 * and adjustments always count (a payment beyond what is owed is "paid ahead");
 * a waiver forgives at most what is owed at that moment, and reversing a
 * waiver brings back exactly what it forgave. Charges are paid off oldest first.
 */
export function walkBalance(driverUserId: string, charges: Charge[], credits: Credit[], commissionWaivedPesewas: number): DriverBalance {
  type Event = { at: number; order: number; charge?: Charge; credit?: Credit };
  const events: Event[] = [
    ...charges.map((c) => ({ at: c.at.getTime(), order: 0, charge: c })),
    ...credits.map((c) => ({ at: c.at.getTime(), order: 1 + c.createdAt.getTime() / 1e15, credit: c })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  const queue: Array<{ at: Date; left: number }> = [];
  let prepaid = 0;
  let owed = 0;
  let paid = 0;
  let waived = 0;
  let adjusted = 0;
  // What each waiver forgave, slice by slice (the charges' dates), so reversing it puts back exactly those.
  const applied = new Map<string, Array<{ at: Date; left: number }>>();
  const consume = (amount: number): Array<{ at: Date; left: number }> => {
    let left = amount;
    const slices: Array<{ at: Date; left: number }> = [];
    while (left > 0 && queue.length) {
      const head = queue[0]!;
      const take = Math.min(head.left, left);
      head.left -= take;
      left -= take;
      slices.push({ at: head.at, left: take });
      if (head.left === 0) queue.shift();
    }
    return slices;
  };
  const sum = (slices: Array<{ left: number }>) => slices.reduce((t, x) => t + x.left, 0);
  const addOwed = (at: Date, amount: number) => {
    const fromPrepaid = Math.min(prepaid, amount);
    prepaid -= fromPrepaid;
    if (amount - fromPrepaid > 0) queue.push({ at, left: amount - fromPrepaid });
  };
  for (const e of events) {
    if (e.charge) {
      owed += e.charge.amount;
      addOwed(e.charge.at, e.charge.amount);
      continue;
    }
    const c = e.credit!;
    if (c.kind === "WAIVER") {
      if (c.amount >= 0) {
        const used = consume(c.amount);
        applied.set(c.id, used);
        waived += sum(used);
      } else {
        const back = c.reversesId ? (applied.get(c.reversesId) ?? []) : [];
        waived -= sum(back);
        for (const slice of back) addOwed(slice.at, slice.left);
        queue.sort((a, b) => a.at.getTime() - b.at.getTime());
      }
      continue;
    }
    if (c.kind === "PAYMENT") paid += c.amount;
    else adjusted += c.amount;
    if (c.amount >= 0) prepaid += c.amount - sum(consume(c.amount));
    else addOwed(c.at, -c.amount);
  }
  const balance = owed - paid - waived - adjusted;
  return {
    driverUserId,
    earnedPesewas: owed + commissionWaivedPesewas,
    commissionWaivedPesewas,
    owedPesewas: owed,
    paidPesewas: paid,
    waivedPesewas: waived,
    adjustedPesewas: adjusted,
    balancePesewas: balance,
    oldestUnpaidAt: balance > 0 ? (queue[0]?.at ?? null) : null,
  };
}

/** Every driver's all-time balance (three queries), optionally only these drivers. */
export async function driverBalances(prisma: Ledgerish, driverUserIds?: readonly string[]): Promise<Map<string, DriverBalance>> {
  const only = driverUserIds ? { driverUserId: { in: [...driverUserIds] } } : {};
  const [charges, waivedTrips, credits] = await Promise.all([
    // Commission on trips completed while commission was waived is never owed.
    prisma.commissionLedger.findMany({ where: { ...only, waived: false }, select: { driverUserId: true, amountPesewas: true, createdAt: true } }),
    prisma.commissionLedger.groupBy({ by: ["driverUserId"], where: { ...only, waived: true }, _sum: { amountPesewas: true } }),
    prisma.driverCashPayment.findMany({
      where: only,
      select: { id: true, driverUserId: true, kind: true, amountPesewas: true, paidAt: true, reversesId: true, createdAt: true },
    }),
  ]);
  const ids = new Set<string>([...charges.map((c) => c.driverUserId), ...waivedTrips.map((w) => w.driverUserId), ...credits.map((c) => c.driverUserId)]);
  const chargesBy = new Map<string, Charge[]>();
  for (const c of charges) chargesBy.set(c.driverUserId, [...(chargesBy.get(c.driverUserId) ?? []), { at: c.createdAt, amount: c.amountPesewas }]);
  const creditsBy = new Map<string, Credit[]>();
  for (const c of credits) {
    creditsBy.set(c.driverUserId, [
      ...(creditsBy.get(c.driverUserId) ?? []),
      { id: c.id, at: c.paidAt, kind: c.kind, amount: c.amountPesewas, reversesId: c.reversesId, createdAt: c.createdAt },
    ]);
  }
  const waivedBy = new Map(waivedTrips.map((w) => [w.driverUserId, w._sum.amountPesewas ?? 0]));
  const out = new Map<string, DriverBalance>();
  for (const id of ids) out.set(id, walkBalance(id, chargesBy.get(id) ?? [], creditsBy.get(id) ?? [], waivedBy.get(id) ?? 0));
  return out;
}

/** One driver's balance (zeros for a driver who never owed anything). */
export async function driverBalance(prisma: Ledgerish, driverUserId: string): Promise<DriverBalance> {
  return (await driverBalances(prisma, [driverUserId])).get(driverUserId) ?? walkBalance(driverUserId, [], [], 0);
}

/** For each driver still owing: when the oldest commission not yet covered was recorded (payments pay off the oldest first). */
export async function oldestUnpaid(prisma: Ledgerish): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (const [id, b] of await driverBalances(prisma)) if (b.oldestUnpaidAt) out.set(id, b.oldestUnpaidAt);
  return out;
}

/** All drivers together: earned = paid + waived + adjusted + still owed − paid ahead. */
export function totalReconciliation(balances: Iterable<DriverBalance>) {
  const t = { earnedPesewas: 0, commissionWaivedPesewas: 0, balanceWaivedPesewas: 0, paidPesewas: 0, adjustedPesewas: 0, stillOwedPesewas: 0, paidAheadPesewas: 0, chargedPesewas: 0 };
  for (const b of balances) {
    t.earnedPesewas += b.earnedPesewas;
    t.commissionWaivedPesewas += b.commissionWaivedPesewas;
    t.balanceWaivedPesewas += b.waivedPesewas;
    t.paidPesewas += b.paidPesewas;
    t.adjustedPesewas += b.adjustedPesewas;
    t.chargedPesewas += b.owedPesewas;
    if (b.balancePesewas > 0) t.stillOwedPesewas += b.balancePesewas;
    else t.paidAheadPesewas += -b.balancePesewas;
  }
  return { ...t, waivedPesewas: t.commissionWaivedPesewas + t.balanceWaivedPesewas };
}

/** Payment status for the period's table: Paid (nothing owed), Part paid (paid something this period), Not paid. */
export function paymentStatus(balancePesewas: number, paidInPeriodPesewas: number): "PAID" | "PART_PAID" | "NOT_PAID" {
  if (balancePesewas <= 0) return "PAID";
  return paidInPeriodPesewas > 0 ? "PART_PAID" : "NOT_PAID";
}

export class CashPaymentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CashPaymentError";
  }
}

/** The largest single payment the form accepts: GH₵100,000. */
export const MAX_PAYMENT_PESEWAS = 10_000_000;

/** Records a payment from a driver, with its audit row, in one transaction. */
export async function recordCashPayment(
  prisma: PrismaClient,
  input: {
    driverUserId: string;
    amountPesewas: number;
    method: CashPaymentMethod;
    note: string | null;
    paidAt: Date;
    adminId: string;
  },
) {
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0 || input.amountPesewas > MAX_PAYMENT_PESEWAS) {
    throw new CashPaymentError("The amount must be more than GH₵0 and at most GH₵100,000.", 400);
  }
  if (input.paidAt.getTime() > Date.now() + 5 * 60_000) {
    throw new CashPaymentError("The payment date can't be in the future.", 400);
  }
  const driver = await prisma.driver.findUnique({ where: { userId: input.driverUserId }, select: { userId: true } });
  if (!driver) throw new CashPaymentError("Driver not found", 404);

  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.driverCashPayment.create({
      data: {
        driverUserId: input.driverUserId,
        amountPesewas: input.amountPesewas,
        method: input.method,
        note: input.note,
        paidAt: input.paidAt,
        recordedBy: input.adminId,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actor: input.adminId,
        action: "cash.payment.record",
        target: created.id,
        reason: `driver ${input.driverUserId}: ${input.amountPesewas} pesewas ${input.method}${input.note ? ` (${input.note})` : ""}`.slice(0, 1000),
      },
    });
    return created;
  });
  clearAdminCache();
  return payment;
}

/** Cancels a payment or waiver with a negative row of the same kind and amount, and a reason. A row can be reversed once; a reversal can't be. */
export async function reverseCashPayment(prisma: PrismaClient, input: { paymentId: string; reason: string; adminId: string }) {
  const original = await prisma.driverCashPayment.findUnique({
    where: { id: input.paymentId },
    select: { id: true, driverUserId: true, kind: true, amountPesewas: true, method: true, reversesId: true, reversal: { select: { id: true } } },
  });
  if (!original) throw new CashPaymentError("Payment not found", 404);
  if (original.reversesId) throw new CashPaymentError("A reversal can't be reversed. Record a new payment instead.", 409);
  if (original.reversal) throw new CashPaymentError("This payment has already been reversed.", 409);

  try {
    const reversal = await prisma.$transaction(async (tx) => {
      const created = await tx.driverCashPayment.create({
        data: {
          driverUserId: original.driverUserId,
          kind: original.kind,
          amountPesewas: -original.amountPesewas,
          method: original.method,
          paidAt: new Date(),
          recordedBy: input.adminId,
          reversesId: original.id,
          reversalReason: input.reason,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actor: input.adminId,
          action: "cash.payment.reverse",
          target: original.id,
          reason: `${original.amountPesewas} pesewas: ${input.reason}`.slice(0, 1000),
        },
      });
      return created;
    });
    clearAdminCache();
    return reversal;
  } catch (err) {
    // Two admins reversing at once: the unique reversesId lets one through.
    if ((err as { code?: string }).code === "P2002") throw new CashPaymentError("This payment has already been reversed.", 409);
    throw err;
  }
}

/**
 * Forgives some or all of what a driver owes, with a required reason
 * (a WAIVER row and its audit row, in one transaction). Never more than
 * they owe now.
 */
export async function waiveBalance(
  prisma: PrismaClient,
  input: { driverUserId: string; amountPesewas: number; reason: string; adminId: string },
) {
  if (!input.reason.trim()) throw new CashPaymentError("Say why the balance is waived.", 400);
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new CashPaymentError("The amount must be more than GH₵0.", 400);
  }
  const driver = await prisma.driver.findUnique({ where: { userId: input.driverUserId }, select: { userId: true } });
  if (!driver) throw new CashPaymentError("Driver not found", 404);
  const { balancePesewas } = await driverBalance(prisma, input.driverUserId);
  if (balancePesewas <= 0) throw new CashPaymentError("This driver owes nothing.", 409);
  if (input.amountPesewas > balancePesewas) throw new CashPaymentError("That's more than the driver owes.", 400);

  const waiver = await prisma.$transaction(async (tx) => {
    const created = await tx.driverCashPayment.create({
      data: {
        driverUserId: input.driverUserId,
        kind: "WAIVER",
        amountPesewas: input.amountPesewas,
        method: null,
        note: input.reason.trim(),
        paidAt: new Date(),
        recordedBy: input.adminId,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actor: input.adminId,
        action: "cash.waive",
        target: created.id,
        reason: `driver ${input.driverUserId}: ${input.amountPesewas} pesewas: ${input.reason.trim()}`.slice(0, 1000),
      },
    });
    return created;
  });
  clearAdminCache();
  return waiver;
}

/**
 * Waives every driver's whole balance at once (the commission-free launch
 * period): a WAIVER row for each driver who owes, worked out inside one
 * transaction, plus one audit row with the count and total. Commission
 * recorded after it stays owed.
 */
export async function waiveAllBalances(prisma: PrismaClient, input: { reason: string; adminId: string }) {
  const reason = input.reason.trim();
  if (!reason) throw new CashPaymentError("Say why every balance is waived.", 400);
  const result = await prisma.$transaction(async (tx) => {
    const balances = await driverBalances(tx);
    const now = new Date();
    const owing = [...balances.values()].filter((b) => b.balancePesewas > 0).map((b) => ({ driverUserId: b.driverUserId, amountPesewas: b.balancePesewas }));
    if (owing.length > 0) {
      await tx.driverCashPayment.createMany({
        data: owing.map((r) => ({
          driverUserId: r.driverUserId,
          kind: "WAIVER" as const,
          amountPesewas: r.amountPesewas,
          method: null,
          note: reason.slice(0, 500),
          paidAt: now,
          recordedBy: input.adminId,
        })),
      });
    }
    const totalPesewas = owing.reduce((sum, r) => sum + r.amountPesewas, 0);
    await tx.adminAuditLog.create({
      data: {
        actor: input.adminId,
        action: "cash.waive.all",
        target: "all-drivers",
        reason: `${owing.length} driver(s), ${totalPesewas} pesewas: ${reason}`.slice(0, 1000),
      },
    });
    return { drivers: owing.length, totalPesewas };
  });
  clearAdminCache();
  return result;
}
