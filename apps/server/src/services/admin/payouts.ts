import type { PrismaClient, TopUpMethod } from "@prisma/client";
import { clearAdminCache } from "./cache";
import { CashPaymentError } from "./cash";
import { loadCompletedTrips } from "./facts";
import { accraDay, daysIn, startOfAccraDay, type Period } from "./period";

/**
 * Payouts (admin site, Payouts & commission): the top-ups CampusRide pays
 * drivers on top of their fares — the launch guarantee — and what each
 * driver made in all:
 *
 *   driver income = fares − commission due + top-ups
 *
 * Fares are the fares of the trips they completed (Ride.completedAt), the
 * same stored seat fares as everywhere else. Commission due is 0 while
 * commission is waived. A top-up counts on the Accra day it was for
 * (`paidOn`). Removed top-ups (a mistake, with a reason) count nowhere.
 */

/** The largest single top-up the form accepts: GH₵10,000. */
export const MAX_TOP_UP_PESEWAS = 1_000_000;

export const TOP_UP_METHODS: readonly TopUpMethod[] = ["MOMO", "CASH"];

export interface TopUpInput {
  driverUserId: string;
  amountPesewas: number;
  /** "YYYY-MM-DD" (Accra). */
  paidOnDay: string;
  method: TopUpMethod;
  note: string | null;
}

/** Records a top-up with its audit row, in one transaction. */
export async function recordTopUp(prisma: PrismaClient, input: TopUpInput, adminId: string, now: Date = new Date()) {
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) throw new CashPaymentError("Enter an amount above GH₵0.", 400);
  if (input.amountPesewas > MAX_TOP_UP_PESEWAS) throw new CashPaymentError("A single top-up can be at most GH₵10,000.", 400);
  const paidOn = startOfAccraDay(input.paidOnDay);
  if (!paidOn) throw new CashPaymentError("Choose the day the top-up was for.", 400);
  if (paidOn.getTime() > now.getTime()) throw new CashPaymentError("The day can't be in the future.", 400);
  const driver = await prisma.driver.findUnique({ where: { userId: input.driverUserId }, select: { userId: true } });
  if (!driver) throw new CashPaymentError("Driver not found", 404);
  const note = input.note?.trim() || null;
  const [row] = await prisma.$transaction([
    prisma.driverTopUp.create({
      data: { driverUserId: input.driverUserId, amountPesewas: input.amountPesewas, paidOn, method: input.method, note, recordedBy: adminId },
    }),
    prisma.adminAuditLog.create({
      data: {
        actor: adminId,
        action: "payout.topup.record",
        target: input.driverUserId,
        reason: `GH₵${(input.amountPesewas / 100).toFixed(2)} ${input.method} for ${input.paidOnDay}${note ? `: ${note}` : ""}`.slice(0, 1000),
      },
    }),
  ]);
  clearAdminCache();
  return row;
}

/** Removes a top-up recorded by mistake (kept, marked removed, with the reason). */
export async function removeTopUp(prisma: PrismaClient, id: string, reason: string, adminId: string, now: Date = new Date()) {
  const why = reason.trim();
  if (!why) throw new CashPaymentError("Say why the top-up is removed.", 400);
  const row = await prisma.driverTopUp.findUnique({ where: { id } });
  if (!row) throw new CashPaymentError("Top-up not found", 404);
  if (row.removedAt) throw new CashPaymentError("This top-up was already removed.", 409);
  const [updated] = await prisma.$transaction([
    prisma.driverTopUp.update({ where: { id }, data: { removedAt: now, removedBy: adminId, removedReason: why.slice(0, 500) } }),
    prisma.adminAuditLog.create({
      data: { actor: adminId, action: "payout.topup.remove", target: row.driverUserId, reason: `GH₵${(row.amountPesewas / 100).toFixed(2)} for ${accraDay(row.paidOn)}: ${why}`.slice(0, 1000) },
    }),
  ]);
  clearAdminCache();
  return updated;
}

export interface DriverIncomeRow {
  userId: string;
  driverId: string | null;
  name: string;
  plate: string | null;
  trips: number;
  riders: number;
  faresPesewas: number;
  commissionDuePesewas: number;
  topUpsPesewas: number;
  incomePesewas: number;
}

export interface DayIncomeRow {
  day: string;
  trips: number;
  faresPesewas: number;
  commissionDuePesewas: number;
  topUpsPesewas: number;
  incomePesewas: number;
}

/** Top-ups paid for days in the period (not removed), by driver user id. */
export async function topUpsByDriver(prisma: PrismaClient, p: Period): Promise<Map<string, number>> {
  const rows = await prisma.driverTopUp.groupBy({
    by: ["driverUserId"],
    where: { paidOn: { gte: startOfAccraDay(accraDay(p.from))!, lt: p.to }, removedAt: null },
    _sum: { amountPesewas: true },
  });
  return new Map(rows.map((r) => [r.driverUserId, r._sum.amountPesewas ?? 0]));
}

/** The Payouts page: the period's top-ups, and fares + top-ups per driver and per day. */
export async function payoutsReport(prisma: PrismaClient, p: Period) {
  const dayStart = startOfAccraDay(accraDay(p.from))!;
  const [topUps, trips, drivers] = await Promise.all([
    prisma.driverTopUp.findMany({
      where: { paidOn: { gte: dayStart, lt: p.to } },
      orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    }),
    loadCompletedTrips(prisma, p),
    prisma.driver.findMany({ select: { id: true, userId: true, plate: true, user: { select: { name: true, isReviewDemo: true } } } }),
  ]);
  const adminIds = [...new Set(topUps.flatMap((t) => [t.recordedBy, t.removedBy]).filter((x): x is string => Boolean(x)))];
  const admins = new Map((await prisma.user.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
  const driverBy = new Map(drivers.map((d) => [d.userId, d]));
  const live = topUps.filter((t) => t.removedAt === null);

  const perDriver = new Map<string, DriverIncomeRow>();
  const driverRow = (userId: string): DriverIncomeRow => {
    let r = perDriver.get(userId);
    if (!r) {
      const d = driverBy.get(userId);
      r = { userId, driverId: d?.id ?? null, name: d?.user.name ?? "Unknown driver", plate: d?.plate ?? null, trips: 0, riders: 0, faresPesewas: 0, commissionDuePesewas: 0, topUpsPesewas: 0, incomePesewas: 0 };
      perDriver.set(userId, r);
    }
    return r;
  };
  const perDay = new Map<string, DayIncomeRow>(daysIn(p).map((day) => [day, { day, trips: 0, faresPesewas: 0, commissionDuePesewas: 0, topUpsPesewas: 0, incomePesewas: 0 }]));
  for (const t of trips) {
    if (!t.driverId || driverBy.get(t.driverId)?.user.isReviewDemo) continue;
    const r = driverRow(t.driverId);
    r.trips += 1;
    r.riders += t.riders;
    r.faresPesewas += t.farePesewas;
    r.commissionDuePesewas += t.commissionDuePesewas;
    const d = perDay.get(accraDay(t.completedAt));
    if (d) {
      d.trips += 1;
      d.faresPesewas += t.farePesewas;
      d.commissionDuePesewas += t.commissionDuePesewas;
    }
  }
  for (const t of live) {
    driverRow(t.driverUserId).topUpsPesewas += t.amountPesewas;
    const d = perDay.get(accraDay(t.paidOn));
    if (d) d.topUpsPesewas += t.amountPesewas;
  }
  for (const r of perDriver.values()) r.incomePesewas = r.faresPesewas - r.commissionDuePesewas + r.topUpsPesewas;
  for (const d of perDay.values()) d.incomePesewas = d.faresPesewas - d.commissionDuePesewas + d.topUpsPesewas;

  const drv = [...perDriver.values()].sort((a, b) => b.incomePesewas - a.incomePesewas);
  const sum = (k: keyof DayIncomeRow) => drv.reduce((s, r) => s + (r[k as keyof DriverIncomeRow] as number), 0);
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      trips: sum("trips"),
      faresPesewas: sum("faresPesewas"),
      commissionDuePesewas: sum("commissionDuePesewas"),
      topUpsPesewas: sum("topUpsPesewas"),
      incomePesewas: sum("incomePesewas"),
      topUpCount: live.length,
    },
    perDriver: drv,
    perDay: [...perDay.values()],
    topUps: topUps.map((t) => ({
      id: t.id,
      driver: { userId: t.driverUserId, driverId: driverBy.get(t.driverUserId)?.id ?? null, name: driverBy.get(t.driverUserId)?.user.name ?? "Unknown driver" },
      amountPesewas: t.amountPesewas,
      paidOn: accraDay(t.paidOn),
      method: t.method,
      note: t.note,
      recordedBy: admins.get(t.recordedBy) ?? "Unknown admin",
      createdAt: t.createdAt.toISOString(),
      removed: t.removedAt
        ? { at: t.removedAt.toISOString(), by: t.removedBy ? (admins.get(t.removedBy) ?? "Unknown admin") : null, reason: t.removedReason }
        : null,
    })),
  };
}
