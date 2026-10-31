import type { FastifyInstance, FastifyReply } from "fastify";
import type { CashPaymentMethod, Prisma, PrismaClient } from "@prisma/client";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { bodyOptional, empty, id, idParams, integer, object, oneOf, text } from "../http/schemas";
import { normalizePhone } from "../lib/phone";
import { RULES } from "../rateLimit/rules";
import { ACTIVE_DRIVER_STATUSES } from "../services/ride/stateMachine";
import { closeDriverSession } from "../services/stats/driverSessions";
import { cached, clearAdminCache } from "../services/admin/cache";
import {
  CashPaymentError,
  driverBalances,
  oldestUnpaid,
  paymentStatus,
  recordCashPayment,
  reverseCashPayment,
} from "../services/admin/cash";
import { loadCompletedTrips, loadSessions } from "../services/admin/facts";
import { acceptance, clippedMs, type OfferRecord } from "../services/admin/metrics";
import { accraDay, daysIn, periodKey, startOfAccraDay, type Period } from "../services/admin/period";
import { RIDE_ROW_SELECT, listPhone, rideRow } from "../services/admin/rows";
import { LOCATION_TRAIL_KEEP_DAYS } from "../services/stats/locationTrail";
import { periodOr400 } from "./adminDashboard";

/**
 * Admin dashboard v2: Drivers (with suspension and the location trail), Cash
 * owed (the payments ledger), Riders and Safety. Definitions:
 * docs/admin-metrics.md. Every change is audit-logged in the same
 * transaction and counts against the admin's change limit; viewing a
 * location trail is audit-logged too.
 */

const period = { from: text(40), to: text(40) };
const periodQuery = { querystring: object(period, ["from", "to"]) };
const write = { limits: { user: [RULES.adminWrite] } };
const reasonBody = object({ reason: text(500, { nonEmpty: true }) }, ["reason"]);

const SCHEMAS = {
  drivers: periodQuery,
  driver: { params: idParams, ...periodQuery },
  trail: { params: idParams, querystring: object({ day: text(10, { nonEmpty: true }) }, ["day"]) },
  suspend: { params: idParams, body: reasonBody },
  cash: periodQuery,
  payments: {
    querystring: object({ ...period, driverId: id, page: integer(1, 10_000), pageSize: integer(1, 2_000) }),
  },
  recordPayment: {
    body: object(
      {
        driverId: id,
        amountPesewas: integer(1, 10_000_000),
        method: oneOf(["CASH", "MOMO", "OTHER"]),
        note: text(500, { nullable: true }),
        paidAt: text(40),
      },
      ["driverId", "amountPesewas", "method"],
    ),
  },
  reverse: { params: idParams, body: reasonBody },
  riders: { querystring: object({ ...period, q: text(80), page: integer(1, 10_000), pageSize: integer(1, 200) }, ["from", "to"]) },
  rider: { params: idParams, querystring: empty },
  safety: periodQuery,
  handleSos: { params: idParams, body: object({ note: text(1000, { nonEmpty: true }) }, ["note"]) },
};

/** A driver by Driver.id or by their User.id (rides name the User). */
function findDriver(prisma: PrismaClient, key: string) {
  return prisma.driver.findFirst({
    where: { OR: [{ id: key }, { userId: key }], user: { isReviewDemo: false } },
    select: {
      id: true,
      userId: true,
      carMake: true,
      carModel: true,
      carColor: true,
      plate: true,
      photoUrl: true,
      isApproved: true,
      isOnline: true,
      suspendedAt: true,
      suspendedReason: true,
      createdAt: true,
      user: { select: { name: true, phone: true, deletedAt: true } },
    },
  });
}

/** Average stars each driver has received, all time. */
async function driverRatings(prisma: PrismaClient, userIds?: string[]) {
  const rows = await prisma.rating.groupBy({
    by: ["rateeId"],
    where: { ratee: { role: "DRIVER" }, ...(userIds ? { rateeId: { in: userIds } } : {}) },
    _avg: { stars: true },
    _count: true,
  });
  return new Map(rows.map((r) => [r.rateeId, { rating: r._avg.stars, ratings: r._count }]));
}

function offersByDriver(rows: Array<OfferRecord & { driverUserId: string }>) {
  const out = new Map<string, OfferRecord[]>();
  for (const r of rows) out.set(r.driverUserId, [...(out.get(r.driverUserId) ?? []), r]);
  return out;
}

function loadOffers(prisma: PrismaClient, p: Period, driverUserId?: string) {
  return prisma.rideOffer.findMany({
    where: { offeredAt: { gte: p.from, lt: p.to }, ...(driverUserId ? { driverUserId } : {}) },
    select: { driverUserId: true, rideId: true, outcome: true, offeredAt: true, decidedAt: true },
    orderBy: { offeredAt: "desc" },
  });
}

function sendCashError(reply: FastifyReply, err: unknown) {
  if (err instanceof CashPaymentError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export function registerAdminPeopleRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const gate = { onRequest: [requireAuth, adminOnly] };

  // ─── Drivers ──────────────────────────────────────────────────────────

  /** Every driver with the period's trips, hours online, earnings (their 85%), acceptance, reply time and rating. */
  app.get("/admin/drivers", { ...gate, schema: SCHEMAS.drivers }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`drivers:${periodKey(p)}`, async () => {
      const now = new Date();
      const [drivers, trips, sessions, offers, ratings, active] = await Promise.all([
        prisma.driver.findMany({
          where: { user: { isReviewDemo: false, deletedAt: null } },
          select: {
            id: true,
            userId: true,
            plate: true,
            carMake: true,
            carModel: true,
            carColor: true,
            photoUrl: true,
            isApproved: true,
            isOnline: true,
            suspendedAt: true,
            createdAt: true,
            user: { select: { name: true, phone: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
        loadCompletedTrips(prisma, p),
        loadSessions(prisma, p),
        loadOffers(prisma, p),
        driverRatings(prisma),
        prisma.ride.findMany({ where: { status: { in: [...ACTIVE_DRIVER_STATUSES] }, driverId: { not: null } }, select: { driverId: true } }),
      ]);
      const onTrip = new Set(active.map((r) => r.driverId));
      const offerMap = offersByDriver(offers);
      const rows = drivers.map((d) => {
        const mine = trips.filter((t) => t.driverId === d.userId);
        const fares = mine.reduce((s, t) => s + t.farePesewas, 0);
        const commission = mine.reduce((s, t) => s + t.commissionPesewas, 0);
        const acc = acceptance(offerMap.get(d.userId) ?? []);
        const r = ratings.get(d.userId);
        return {
          driverId: d.id,
          userId: d.userId,
          name: d.user.name,
          maskedPhone: listPhone(d.user.phone),
          plate: d.plate,
          car: [d.carColor, d.carMake, d.carModel].filter(Boolean).join(" ") || null,
          photoUrl: d.photoUrl,
          isApproved: d.isApproved,
          isOnline: d.isOnline,
          suspended: d.suspendedAt !== null,
          onTrip: onTrip.has(d.userId),
          joinedAt: d.createdAt.toISOString(),
          trips: mine.length,
          hoursOnlineMs: sessions.filter((s) => s.driverUserId === d.userId).reduce((sum, s) => sum + clippedMs(s, p, now), 0),
          earnedPesewas: fares - commission,
          offers: acc.offers,
          acceptanceRate: acc.rate,
          avgReplyMs: acc.avgReplyMs,
          rating: r?.rating ?? null,
          ratings: r?.ratings ?? 0,
        };
      });
      return {
        generatedAt: now.toISOString(),
        drivers: rows,
        counts: {
          all: rows.length,
          online: rows.filter((r) => r.isOnline).length,
          needsApproval: rows.filter((r) => !r.isApproved && !r.suspended).length,
          suspended: rows.filter((r) => r.suspended).length,
        },
      };
    });
    return reply.send(body);
  });

  /** One driver: car, the period's earnings and stats, balance owed, recent trips, sessions, offers, and the days with a location trail. */
  app.get("/admin/drivers/:id", { ...gate, schema: SCHEMAS.driver }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const driver = await findDriver(prisma, (request.params as { id: string }).id);
    if (!driver) return reply.code(404).send({ error: "Driver not found" });
    const body = await cached(`driver:${driver.userId}:${periodKey(p)}`, async () => {
      const now = new Date();
      const userId = driver.userId;
      const [trips, sessions, offers, ratings, balances, owedSince, cancelledByDriver, recent, sessionRows, trailDays] = await Promise.all([
        loadCompletedTrips(prisma, p, { driverId: userId }),
        loadSessions(prisma, p, { driverUserId: userId }),
        loadOffers(prisma, p, userId),
        driverRatings(prisma, [userId]),
        driverBalances(prisma, [userId]),
        oldestUnpaid(prisma),
        prisma.ride.count({ where: { driverId: userId, cancelReason: "DRIVER_BACKED_OUT", createdAt: { gte: p.from, lt: p.to } } }),
        prisma.ride.findMany({ where: { driverId: userId, isReviewDemo: false }, select: RIDE_ROW_SELECT, orderBy: { createdAt: "desc" }, take: 10 }),
        prisma.driverOnlineSession.findMany({
          where: { driverUserId: userId, startedAt: { lt: p.to }, OR: [{ endedAt: null }, { endedAt: { gt: p.from } }] },
          select: { startedAt: true, endedAt: true, endReason: true, lastSeenAt: true },
          orderBy: { startedAt: "desc" },
          take: 100,
        }),
        prisma.$queryRaw<Array<{ day: string }>>`
          SELECT DISTINCT to_char("recordedAt", 'YYYY-MM-DD') AS day FROM "DriverLocationPoint"
          WHERE "driverUserId" = ${userId} AND "recordedAt" > ${new Date(Date.now() - LOCATION_TRAIL_KEEP_DAYS * 86_400_000)}
          ORDER BY day DESC`,
      ]);
      const fares = trips.reduce((s, t) => s + t.farePesewas, 0);
      const commission = trips.reduce((s, t) => s + t.commissionPesewas, 0);
      const acc = acceptance(offers);
      const balance = balances.get(userId);
      return {
        generatedAt: now.toISOString(),
        period: {
          trips: trips.length,
          faresPesewas: fares,
          commissionPesewas: commission,
          earnedPesewas: fares - commission,
          hoursOnlineMs: sessions.reduce((sum, s) => sum + clippedMs(s, p, now), 0),
          offers: acc.offers,
          accepted: acc.accepted,
          declined: acc.declined,
          timedOut: acc.timedOut,
          acceptanceRate: acc.rate,
          avgReplyMs: acc.avgReplyMs,
          cancelledByDriver,
        },
        rating: ratings.get(userId)?.rating ?? null,
        ratings: ratings.get(userId)?.ratings ?? 0,
        balance: {
          owedPesewas: balance?.owedPesewas ?? 0,
          paidPesewas: balance?.paidPesewas ?? 0,
          balancePesewas: balance?.balancePesewas ?? 0,
          oldestUnpaidAt: owedSince.get(userId)?.toISOString() ?? null,
        },
        recentTrips: recent.map(rideRow),
        sessions: sessionRows.map((s) => ({
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt?.toISOString() ?? null,
          endReason: s.endReason,
          ms: clippedMs({ driverUserId: userId, ...s }, { from: new Date(0), to: now }, now),
        })),
        offers: offers.slice(0, 50).map((o) => ({
          rideId: o.rideId,
          offeredAt: o.offeredAt.toISOString(),
          outcome: o.outcome,
          responseMs: o.decidedAt ? o.decidedAt.getTime() - o.offeredAt.getTime() : null,
        })),
        trailDays: trailDays.map((d) => d.day),
      };
    });
    return reply.send({
      driver: {
        driverId: driver.id,
        userId: driver.userId,
        name: driver.user.name,
        phone: driver.user.deletedAt ? null : driver.user.phone,
        carMake: driver.carMake,
        carModel: driver.carModel,
        carColor: driver.carColor,
        plate: driver.plate,
        photoUrl: driver.photoUrl,
        isApproved: driver.isApproved,
        isOnline: driver.isOnline,
        suspendedAt: driver.suspendedAt?.toISOString() ?? null,
        suspendedReason: driver.suspendedReason,
        joinedAt: driver.createdAt.toISOString(),
      },
      ...body,
    });
  });

  /**
   * One driver's location trail for one Accra day (about a point every 30 s
   * while online). Audit-logged ("driver.trail.view"): it shows where a
   * person was. Kept 90 days.
   */
  app.get("/admin/drivers/:id/trail", { ...gate, schema: SCHEMAS.trail, config: { limits: { user: [RULES.adminTrail] } } }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { day } = request.query as { day: string };
    const start = startOfAccraDay(day);
    if (!start) return reply.code(400).send({ error: "day must be YYYY-MM-DD" });
    const driver = await findDriver(prisma, (request.params as { id: string }).id);
    if (!driver) return reply.code(404).send({ error: "Driver not found" });
    const end = new Date(start.getTime() + 24 * 60 * 60_000);
    const [points] = await prisma.$transaction([
      prisma.driverLocationPoint.findMany({
        where: { driverUserId: driver.userId, recordedAt: { gte: start, lt: end } },
        select: { latitude: true, longitude: true, recordedAt: true, onTrip: true },
        orderBy: { recordedAt: "asc" },
        take: 10_000,
      }),
      prisma.adminAuditLog.create({
        data: { actor: request.user!.userId, action: "driver.trail.view", target: driver.id, reason: `day ${day}` },
      }),
    ]);
    return reply.send({
      day,
      points: points.map((pt) => ({ latitude: pt.latitude, longitude: pt.longitude, at: pt.recordedAt.toISOString(), onTrip: pt.onTrip })),
    });
  });

  /**
   * Suspends a driver: offline at once, out of dispatch, and refused going
   * online (PATCH /driver/availability answers DRIVER_SUSPENDED) until an
   * admin lifts it. Keeps their approval. A reason is required.
   */
  app.post("/admin/drivers/:id/suspend", { ...gate, schema: SCHEMAS.suspend, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { reason } = request.body as { reason: string };
    if (!reason.trim()) return reply.code(400).send({ error: "Say why the driver is suspended" });
    const driver = await findDriver(prisma, (request.params as { id: string }).id);
    if (!driver) return reply.code(404).send({ error: "Driver not found" });
    if (driver.suspendedAt) return reply.code(409).send({ error: "This driver is already suspended" });
    const adminId = request.user!.userId;
    await prisma.$transaction([
      prisma.driver.update({
        where: { id: driver.id },
        data: { suspendedAt: new Date(), suspendedReason: reason.trim(), suspendedBy: adminId, isOnline: false, currentZoneId: null },
      }),
      prisma.adminAuditLog.create({ data: { actor: adminId, action: "driver.suspend", target: driver.id, reason: reason.trim() } }),
    ]);
    await closeDriverSession(prisma, driver.userId, "ADMIN");
    clearAdminCache();
    return reply.send({ suspended: true });
  });

  app.post("/admin/drivers/:id/unsuspend", { ...gate, schema: SCHEMAS.suspend, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { reason } = request.body as { reason: string };
    if (!reason.trim()) return reply.code(400).send({ error: "Say why the suspension is lifted" });
    const driver = await findDriver(prisma, (request.params as { id: string }).id);
    if (!driver) return reply.code(404).send({ error: "Driver not found" });
    if (!driver.suspendedAt) return reply.code(409).send({ error: "This driver isn't suspended" });
    await prisma.$transaction([
      prisma.driver.update({ where: { id: driver.id }, data: { suspendedAt: null, suspendedReason: null, suspendedBy: null } }),
      prisma.adminAuditLog.create({ data: { actor: request.user!.userId, action: "driver.unsuspend", target: driver.id, reason: reason.trim() } }),
    ]);
    clearAdminCache();
    return reply.send({ suspended: false });
  });

  // ─── Cash owed ────────────────────────────────────────────────────────

  /** Still owed (all time), the 15% earned and the cash paid in during the period, and every driver's row. */
  app.get("/admin/cash", { ...gate, schema: SCHEMAS.cash }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`cash:${periodKey(p)}`, async () => {
      const [balances, since, trips, paidRows, drivers] = await Promise.all([
        driverBalances(prisma),
        oldestUnpaid(prisma),
        loadCompletedTrips(prisma, p),
        prisma.driverCashPayment.findMany({ where: { paidAt: { gte: p.from, lt: p.to } }, select: { driverUserId: true, amountPesewas: true, reversesId: true } }),
        prisma.driver.findMany({ select: { id: true, userId: true, plate: true, user: { select: { name: true, isReviewDemo: true } } } }),
      ]);
      const owedInPeriod = new Map<string, number>();
      for (const t of trips) if (t.driverId) owedInPeriod.set(t.driverId, (owedInPeriod.get(t.driverId) ?? 0) + t.commissionPesewas);
      const paidInPeriod = new Map<string, number>();
      for (const r of paidRows) paidInPeriod.set(r.driverUserId, (paidInPeriod.get(r.driverUserId) ?? 0) + r.amountPesewas);

      const rows = drivers
        .filter((d) => !d.user.isReviewDemo)
        .map((d) => {
          const balance = balances.get(d.userId)?.balancePesewas ?? 0;
          const paid = paidInPeriod.get(d.userId) ?? 0;
          return {
            userId: d.userId,
            driverId: d.id,
            name: d.user.name,
            plate: d.plate,
            owedInPeriodPesewas: owedInPeriod.get(d.userId) ?? 0,
            paidInPeriodPesewas: paid,
            balancePesewas: balance,
            oldestUnpaidAt: since.get(d.userId)?.toISOString() ?? null,
            status: paymentStatus(balance, paid),
          };
        })
        .filter((r) => r.owedInPeriodPesewas !== 0 || r.paidInPeriodPesewas !== 0 || r.balancePesewas !== 0)
        .sort((a, b) => b.balancePesewas - a.balancePesewas);
      const owing = rows.filter((r) => r.balancePesewas > 0);
      const oldest = owing.map((r) => r.oldestUnpaidAt).filter((x): x is string => x !== null).sort()[0] ?? null;
      return {
        generatedAt: new Date().toISOString(),
        outstandingPesewas: owing.reduce((s, r) => s + r.balancePesewas, 0),
        driversOwing: owing.length,
        oldestUnpaidAt: oldest,
        earnedInPeriodPesewas: trips.reduce((s, t) => s + t.commissionPesewas, 0),
        faresInPeriodPesewas: trips.reduce((s, t) => s + t.farePesewas, 0),
        paidInPeriodPesewas: paidRows.reduce((s, r) => s + r.amountPesewas, 0),
        paymentsInPeriod: paidRows.filter((r) => r.reversesId === null).length,
        drivers: rows,
      };
    });
    return reply.send(body);
  });

  /** The payments ledger, newest first: by period (paidAt) and driver. Reversals show what they cancel. */
  app.get("/admin/cash/payments", { ...gate, schema: SCHEMAS.payments }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = request.query as { from?: string; to?: string; driverId?: string; page?: number; pageSize?: number };
    const where: Prisma.DriverCashPaymentWhereInput = {};
    if (q.from || q.to) {
      const p = periodOr400(q, reply);
      if (!p) return;
      where.paidAt = { gte: p.from, lt: p.to };
    }
    if (q.driverId) {
      const driver = await findDriver(prisma, q.driverId);
      if (!driver) return reply.code(404).send({ error: "Driver not found" });
      where.driverUserId = driver.userId;
    }
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const [rows, total] = await Promise.all([
      prisma.driverCashPayment.findMany({
        where,
        orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { driver: { select: { id: true, name: true } }, reversal: { select: { id: true, createdAt: true, reversalReason: true } } },
      }),
      prisma.driverCashPayment.count({ where }),
    ]);
    const admins = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.recordedBy))] } }, select: { id: true, name: true } });
    const byId = new Map(admins.map((a) => [a.id, a]));
    return reply.send({
      payments: rows.map((r) => ({
        id: r.id,
        driver: r.driver,
        amountPesewas: r.amountPesewas,
        method: r.method,
        note: r.note,
        paidAt: r.paidAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        recordedBy: byId.get(r.recordedBy) ?? { id: r.recordedBy, name: "Unknown admin" },
        reversesId: r.reversesId,
        reversalReason: r.reversalReason,
        reversedBy: r.reversal ? { id: r.reversal.id, at: r.reversal.createdAt.toISOString(), reason: r.reversal.reversalReason } : null,
      })),
      total,
      page,
      pageSize,
    });
  });

  /** Records cash a driver handed over (partial is fine). Audit-logged with the admin. */
  app.post("/admin/cash/payments", { ...gate, schema: SCHEMAS.recordPayment, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { driverId: string; amountPesewas: number; method: CashPaymentMethod; note?: string | null; paidAt?: string };
    const driver = await findDriver(prisma, body.driverId);
    if (!driver) return reply.code(404).send({ error: "Driver not found" });
    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) return reply.code(400).send({ error: "paidAt must be an ISO time" });
    try {
      const payment = await recordCashPayment(prisma, {
        driverUserId: driver.userId,
        amountPesewas: body.amountPesewas,
        method: body.method,
        note: body.note?.trim() || null,
        paidAt,
        adminId: request.user!.userId,
      });
      return reply.code(201).send({ payment: { id: payment.id, amountPesewas: payment.amountPesewas, paidAt: payment.paidAt.toISOString() } });
    } catch (err) {
      return sendCashError(reply, err);
    }
  });

  /** Reverses a payment (a negative entry with a reason). Payments are never edited or deleted. */
  app.post("/admin/cash/payments/:id/reverse", { ...gate, schema: SCHEMAS.reverse, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { reason } = request.body as { reason: string };
    if (!reason.trim()) return reply.code(400).send({ error: "Say why the payment is reversed" });
    try {
      const reversal = await reverseCashPayment(prisma, {
        paymentId: (request.params as { id: string }).id,
        reason: reason.trim(),
        adminId: request.user!.userId,
      });
      return reply.code(201).send({ reversal: { id: reversal.id, amountPesewas: reversal.amountPesewas } });
    } catch (err) {
      return sendCashError(reply, err);
    }
  });

  // ─── Riders ───────────────────────────────────────────────────────────

  /** Rider totals for the period, sign-ups per day, and one page of riders (phones masked; search by phone or name). */
  app.get("/admin/riders", { ...gate, schema: SCHEMAS.riders }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const q = request.query as { q?: string; page?: number; pageSize?: number };
    const riderWhere: Prisma.UserWhereInput = { role: "RIDER", deletedAt: null, isReviewDemo: false };
    const totals = await cached(`riders:${periodKey(p)}`, async () => {
      const completedSeat = { status: { not: "CANCELLED" as const }, ride: { status: "COMPLETED" as const, isReviewDemo: false } };
      const [riders, joined, active, everRode, returning] = await Promise.all([
        prisma.user.count({ where: riderWhere }),
        prisma.user.findMany({ where: { ...riderWhere, createdAt: { gte: p.from, lt: p.to } }, select: { createdAt: true } }),
        prisma.ridePassenger.groupBy({ by: ["riderId"], where: { ...completedSeat, ride: { ...completedSeat.ride, completedAt: { gte: p.from, lt: p.to } } } }),
        prisma.ridePassenger.groupBy({ by: ["riderId"], where: completedSeat }),
        prisma.ridePassenger.groupBy({ by: ["riderId"], where: completedSeat, having: { riderId: { _count: { gte: 2 } } } }),
      ]);
      const perDay = new Map(daysIn(p).map((d) => [d, 0]));
      for (const u of joined) perDay.set(accraDay(u.createdAt), (perDay.get(accraDay(u.createdAt)) ?? 0) + 1);
      return {
        generatedAt: new Date().toISOString(),
        riders,
        newInPeriod: joined.length,
        activeInPeriod: active.length,
        riddenEver: everRode.length,
        returning: returning.length,
        returningRate: everRode.length ? returning.length / everRode.length : null,
        signupsPerDay: [...perDay.entries()].map(([day, count]) => ({ day, count })),
      };
    });

    const where: Prisma.UserWhereInput = { ...riderWhere };
    const term = q.q?.trim();
    if (term) {
      const phone = normalizePhone(term);
      if (phone) where.phone = phone;
      else where.name = { contains: term, mode: "insensitive" };
    }
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, name: true, phone: true, createdAt: true, earlyAccessAt: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ]);
    const seats = await prisma.ridePassenger.findMany({
      where: { riderId: { in: users.map((u) => u.id) }, status: { not: "CANCELLED" }, ride: { status: "COMPLETED" } },
      select: { riderId: true, ride: { select: { completedAt: true } } },
    });
    const stats = new Map<string, { rides: number; last: Date | null }>();
    for (const s of seats) {
      const e = stats.get(s.riderId) ?? { rides: 0, last: null };
      e.rides += 1;
      if (s.ride.completedAt && (!e.last || s.ride.completedAt > e.last)) e.last = s.ride.completedAt;
      stats.set(s.riderId, e);
    }
    return reply.send({
      ...totals,
      riders: totals.riders,
      list: users.map((u) => ({
        id: u.id,
        name: u.name,
        maskedPhone: listPhone(u.phone),
        joinedAt: u.createdAt.toISOString(),
        rides: stats.get(u.id)?.rides ?? 0,
        lastRideAt: stats.get(u.id)?.last?.toISOString() ?? null,
        earlyAccess: u.earlyAccessAt !== null,
      })),
      total,
      page,
      pageSize,
    });
  });

  /** One rider in full (their full number is here only): rides, ratings given, SOS. */
  app.get("/admin/riders/:id", { ...gate, schema: SCHEMAS.rider }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const riderId = (request.params as { id: string }).id;
    const user = await prisma.user.findFirst({
      where: { id: riderId, role: "RIDER", isReviewDemo: false },
      select: { id: true, name: true, phone: true, createdAt: true, deletedAt: true, earlyAccessAt: true, emergencyContactPhone: true },
    });
    if (!user) return reply.code(404).send({ error: "Rider not found" });
    const mine: Prisma.RideWhereInput = { isReviewDemo: false, OR: [{ riderId }, { passengers: { some: { riderId } } }] };
    const [rides, requests, completed, cancelled, ratings, sos] = await Promise.all([
      prisma.ride.findMany({ where: mine, select: RIDE_ROW_SELECT, orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.ride.count({ where: { riderId, isReviewDemo: false } }),
      prisma.ridePassenger.count({ where: { riderId, status: { not: "CANCELLED" }, ride: { status: "COMPLETED" } } }),
      prisma.ride.count({ where: { riderId, status: "CANCELLED", cancelReason: "RIDER_CANCELLED" } }),
      prisma.rating.findMany({
        where: { raterId: riderId },
        select: { stars: true, comment: true, createdAt: true, rideId: true, ratee: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.sosEvent.findMany({ where: { riderId }, select: { id: true, rideId: true, createdAt: true, handledAt: true }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);
    return reply.send({
      rider: {
        id: user.id,
        name: user.name,
        phone: user.deletedAt ? null : user.phone,
        joinedAt: user.createdAt.toISOString(),
        closed: user.deletedAt !== null,
        earlyAccessAt: user.earlyAccessAt?.toISOString() ?? null,
        hasEmergencyContact: Boolean(user.emergencyContactPhone),
      },
      stats: { requests, completed, cancelled },
      rides: rides.map(rideRow),
      ratingsGiven: ratings.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      sos: sos.map((e) => ({ ...e, createdAt: e.createdAt.toISOString(), handledAt: e.handledAt?.toISOString() ?? null })),
    });
  });

  // ─── Safety ───────────────────────────────────────────────────────────

  /**
   * Every open SOS (whenever raised), the period's handled ones, SOSes from
   * before SOS records existed (only their tracking link is known), and the
   * period's 1–2 star ratings.
   */
  app.get("/admin/safety", { ...gate, schema: SCHEMAS.safety }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`safety:${periodKey(p)}`, async () => {
      const [events, low, links] = await Promise.all([
        prisma.sosEvent.findMany({
          where: { OR: [{ handledAt: null }, { createdAt: { gte: p.from, lt: p.to } }] },
          include: {
            rider: { select: { id: true, name: true, phone: true } },
            ride: { select: { id: true, pickupLabel: true, dropoffLabel: true, pickupZone: { select: { name: true } }, dropoffZone: { select: { name: true } }, driver: { select: { id: true, name: true } } } },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.rating.findMany({
          where: { stars: { lte: 2 }, createdAt: { gte: p.from, lt: p.to } },
          select: {
            id: true,
            stars: true,
            comment: true,
            createdAt: true,
            rideId: true,
            rater: { select: { id: true, name: true, role: true } },
            ratee: { select: { id: true, name: true, role: true, driver: { select: { id: true } } } },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.trackingLink.findMany({
          where: { createdAt: { gte: p.from, lt: p.to } },
          select: { rideId: true, riderId: true, createdAt: true, rider: { select: { name: true } } },
        }),
      ]);
      const handlers = await prisma.user.findMany({
        where: { id: { in: [...new Set(events.map((e) => e.handledBy).filter((x): x is string => x !== null))] } },
        select: { id: true, name: true },
      });
      const byId = new Map(handlers.map((h) => [h.id, h]));
      const recorded = await prisma.sosEvent.findMany({ where: { rideId: { in: links.map((l) => l.rideId) } }, select: { rideId: true, riderId: true } });
      const known = new Set(recorded.map((r) => `${r.rideId}:${r.riderId}`));
      const sos = events
        .map((e) => ({
          id: e.id,
          createdAt: e.createdAt.toISOString(),
          rideId: e.rideId,
          rideStatus: e.rideStatus,
          route: `${e.ride.pickupLabel ?? e.ride.pickupZone.name} → ${e.ride.dropoffLabel ?? e.ride.dropoffZone.name}`,
          rider: { id: e.rider.id, name: e.rider.name, maskedPhone: listPhone(e.rider.phone) },
          driver: e.ride.driver,
          latitude: e.latitude,
          longitude: e.longitude,
          hasContact: e.hasContact,
          smsDelivered: e.smsDelivered,
          supportNotified: e.supportNotified,
          handledAt: e.handledAt?.toISOString() ?? null,
          handledBy: e.handledBy ? (byId.get(e.handledBy) ?? { id: e.handledBy, name: "Unknown admin" }) : null,
          handledNote: e.handledNote,
        }))
        .sort((a, b) => Number(a.handledAt !== null) - Number(b.handledAt !== null) || b.createdAt.localeCompare(a.createdAt));
      return {
        generatedAt: new Date().toISOString(),
        openCount: sos.filter((s) => !s.handledAt).length,
        sos,
        earlierSos: links
          .filter((l) => !known.has(`${l.rideId}:${l.riderId}`))
          .map((l) => ({ rideId: l.rideId, riderName: l.rider.name, createdAt: l.createdAt.toISOString() })),
        lowRatings: low.map((r) => ({
          id: r.id,
          stars: r.stars,
          comment: r.comment,
          createdAt: r.createdAt.toISOString(),
          rideId: r.rideId,
          rater: r.rater,
          ratee: { id: r.ratee.id, name: r.ratee.name, role: r.ratee.role, driverId: r.ratee.driver?.id ?? null },
        })),
      };
    });
    return reply.send(body);
  });

  /** Marks an SOS handled, with what was done (required). Audit-logged ("sos.handle"). */
  app.post("/admin/sos/:id/handle", { ...gate, preValidation: bodyOptional, schema: SCHEMAS.handleSos, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { note } = request.body as { note: string };
    if (!note.trim()) return reply.code(400).send({ error: "Write what was done" });
    const eventId = (request.params as { id: string }).id;
    const adminId = request.user!.userId;
    const count = await prisma.$transaction(async (tx) => {
      const updated = await tx.sosEvent.updateMany({
        where: { id: eventId, handledAt: null },
        data: { handledAt: new Date(), handledBy: adminId, handledNote: note.trim() },
      });
      if (updated.count > 0) {
        await tx.adminAuditLog.create({ data: { actor: adminId, action: "sos.handle", target: eventId, reason: note.trim().slice(0, 1000) } });
      }
      return updated.count;
    });
    if (count === 0) {
      const exists = await prisma.sosEvent.findUnique({ where: { id: eventId }, select: { id: true } });
      return exists ? reply.code(409).send({ error: "Someone already marked this SOS handled" }) : reply.code(404).send({ error: "SOS not found" });
    }
    clearAdminCache();
    return reply.send({ handled: true });
  });
}
