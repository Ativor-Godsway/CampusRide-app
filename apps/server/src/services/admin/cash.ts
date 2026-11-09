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
  /** All-time commission on completed cash rides. */
  owedPesewas: number;
  /** All-time payments (in person and Paystack), reversals taken off. */
  paidPesewas: number;
  /** All-time waivers, reversals taken off. */
  waivedPesewas: number;
  /** All-time adjustments. */
  adjustedPesewas: number;
  /** owed − paid − waived − adjusted. Positive: the driver still owes. */
  balancePesewas: number;
}

/** Every driver's all-time balance (two grouped queries), optionally only these drivers. */
export async function driverBalances(prisma: PrismaClient, driverUserIds?: readonly string[]): Promise<Map<string, DriverBalance>> {
  const only = driverUserIds ? { driverUserId: { in: [...driverUserIds] } } : {};
  const [owed, credited] = await Promise.all([
    prisma.commissionLedger.groupBy({ by: ["driverUserId"], where: only, _sum: { amountPesewas: true } }),
    prisma.driverCashPayment.groupBy({ by: ["driverUserId", "kind"], where: only, _sum: { amountPesewas: true } }),
  ]);
  const out = new Map<string, DriverBalance>();
  const row = (id: string) => {
    let b = out.get(id);
    if (!b) {
      b = { driverUserId: id, owedPesewas: 0, paidPesewas: 0, waivedPesewas: 0, adjustedPesewas: 0, balancePesewas: 0 };
      out.set(id, b);
    }
    return b;
  };
  for (const o of owed) row(o.driverUserId).owedPesewas = o._sum.amountPesewas ?? 0;
  for (const c of credited) {
    const b = row(c.driverUserId);
    const amount = c._sum.amountPesewas ?? 0;
    if (c.kind === "WAIVER") b.waivedPesewas += amount;
    else if (c.kind === "ADJUSTMENT") b.adjustedPesewas += amount;
    else b.paidPesewas += amount;
  }
  for (const b of out.values()) b.balancePesewas = b.owedPesewas - b.paidPesewas - b.waivedPesewas - b.adjustedPesewas;
  return out;
}

/** One driver's balance (zeros for a driver who never owed anything). */
export async function driverBalance(prisma: PrismaClient, driverUserId: string): Promise<DriverBalance> {
  return (
    (await driverBalances(prisma, [driverUserId])).get(driverUserId) ?? {
      driverUserId,
      owedPesewas: 0,
      paidPesewas: 0,
      waivedPesewas: 0,
      adjustedPesewas: 0,
      balancePesewas: 0,
    }
  );
}

/**
 * For each driver still owing: when the oldest commission not yet covered
 * by their payments was recorded (payments pay off the oldest first). One
 * query with a running total.
 */
export async function oldestUnpaid(prisma: PrismaClient): Promise<Map<string, Date>> {
  const rows = await prisma.$queryRaw<Array<{ driverUserId: string; since: Date }>>`
    WITH running AS (
      SELECT "driverUserId", "createdAt",
             SUM("amountPesewas") OVER (PARTITION BY "driverUserId" ORDER BY "createdAt", id) AS cumulative
      FROM "CommissionLedger"
    ),
    paid AS (
      SELECT "driverUserId", SUM("amountPesewas") AS total FROM "DriverCashPayment" GROUP BY "driverUserId"
    )
    SELECT r."driverUserId", MIN(r."createdAt") AS since
    FROM running r LEFT JOIN paid p ON p."driverUserId" = r."driverUserId"
    WHERE r.cumulative > COALESCE(p.total, 0)
    GROUP BY r."driverUserId"`;
  return new Map(rows.map((r) => [r.driverUserId, r.since]));
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
    const rows = await tx.$queryRaw<Array<{ driverUserId: string; balance: bigint }>>`
      SELECT c."driverUserId", c.owed - COALESCE(p.credited, 0) AS balance
      FROM (SELECT "driverUserId", SUM("amountPesewas") AS owed FROM "CommissionLedger" GROUP BY "driverUserId") c
      LEFT JOIN (SELECT "driverUserId", SUM("amountPesewas") AS credited FROM "DriverCashPayment" GROUP BY "driverUserId") p
        ON p."driverUserId" = c."driverUserId"
      WHERE c.owed - COALESCE(p.credited, 0) > 0`;
    const now = new Date();
    const owing = rows.map((r) => ({ driverUserId: r.driverUserId, amountPesewas: Number(r.balance) }));
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
