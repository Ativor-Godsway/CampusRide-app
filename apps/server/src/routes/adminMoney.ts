import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient, TopUpMethod } from "@prisma/client";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { boolean, empty, id, idParams, integer, object, oneOf, text } from "../http/schemas";
import { RULES } from "../rateLimit/rules";
import { cached, clearAdminCache } from "../services/admin/cache";
import { CashPaymentError } from "../services/admin/cash";
import { LAUNCH_DAY, loadKpis } from "../services/admin/kpis";
import { periodKey } from "../services/admin/period";
import { MAX_TOP_UP_PESEWAS, payoutsReport, recordTopUp, removeTopUp } from "../services/admin/payouts";
import {
  COMMISSION_RATE_BOUNDS_BPS,
  commissionTermsProblem,
  getCommissionTerms,
  saveCommissionTerms,
} from "../services/commission/settings";
import { periodOr400 } from "./adminDashboard";

/**
 * Admin redesign (2026-11-29):
 * - the investor KPIs for any period (Overview), by the week-1 report's
 *   definitions (services/admin/kpis.ts);
 * - the commission rate and the waiver (Payouts & commission, Settings);
 * - top-ups paid to drivers and each driver's income (Payouts);
 * - when each Settings section was last changed, and by whom.
 * Every change is audit-logged and counts against the admin's change limit.
 */

const period = { from: text(40), to: text(40) };
const write = { limits: { user: [RULES.adminWrite] } };

const SCHEMAS = {
  kpis: { querystring: object(period, ["from", "to"]) },
  terms: { querystring: empty },
  saveTerms: {
    body: object(
      {
        rateBps: integer(COMMISSION_RATE_BOUNDS_BPS.min, COMMISSION_RATE_BOUNDS_BPS.max),
        waived: boolean,
        waivedFromDay: text(10, { nullable: true }),
      },
      ["rateBps", "waived"],
    ),
  },
  payouts: { querystring: object(period, ["from", "to"]) },
  recordTopUp: {
    body: object(
      {
        driverId: id,
        amountPesewas: integer(1, MAX_TOP_UP_PESEWAS),
        paidOn: text(10, { nonEmpty: true }),
        method: oneOf(["MOMO", "CASH"]),
        note: text(500, { nullable: true }),
      },
      ["driverId", "amountPesewas", "paidOn", "method"],
    ),
  },
  removeTopUp: { params: idParams, body: object({ reason: text(500, { nonEmpty: true }) }, ["reason"]) },
  settingsChanges: { querystring: empty },
};

/** Settings sections and the audit actions that change them (Settings: "Last changed by X at …"). */
export const SETTINGS_SECTIONS: Record<string, readonly string[]> = {
  serviceHours: ["service_hours.update", "service_hours.override"],
  dispatch: ["dispatch.search_window", "dispatch.moving_first"],
  pricing: ["fares.update", "ride.wait_fee", "zones.neighbours"],
  scheduled: ["schedule.settings"],
  commission: ["commission.settings", "commission.terms"],
  notifications: ["launch.update", "notification.send", "notification.launch", "notification.opening"],
  admins: ["admin.passkey.add", "admin.passkey.remove"],
};

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof CashPaymentError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

async function termsBody(prisma: PrismaClient) {
  const terms = await getCommissionTerms(prisma);
  const by = terms.updatedBy ? await prisma.user.findUnique({ where: { id: terms.updatedBy }, select: { id: true, name: true } }) : null;
  const [waivedTotal, dueTotal] = await Promise.all([
    prisma.commissionLedger.aggregate({ where: { waived: true }, _sum: { amountPesewas: true }, _count: true }),
    prisma.commissionLedger.aggregate({ where: { waived: false }, _sum: { amountPesewas: true }, _count: true }),
  ]);
  return {
    terms: {
      rateBps: terms.rateBps,
      waived: terms.waived,
      waivedFromDay: terms.waivedFrom?.toISOString().slice(0, 10) ?? null,
      updatedAt: terms.updatedAt?.toISOString() ?? null,
      updatedBy: by,
    },
    bounds: COMMISSION_RATE_BOUNDS_BPS,
    launchDay: LAUNCH_DAY,
    /** All time: commission kept for the record but not owed (waived), and commission owed. */
    totals: {
      waivedPesewas: waivedTotal._sum.amountPesewas ?? 0,
      waivedTrips: waivedTotal._count,
      chargedPesewas: dueTotal._sum.amountPesewas ?? 0,
      chargedTrips: dueTotal._count,
    },
  };
}

export function registerAdminMoneyRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const gate = { onRequest: [requireAuth, adminOnly] };

  /** The investor KPIs, charts, funnel and retention for a period (cached a minute). */
  app.get("/admin/kpis", { ...gate, schema: SCHEMAS.kpis }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`kpis:${periodKey(p)}`, async () => {
      const terms = await getCommissionTerms(prisma);
      return { generatedAt: new Date().toISOString(), launchDay: LAUNCH_DAY, ...(await loadKpis(prisma, p, terms.rateBps)) };
    });
    return reply.send(body);
  });

  /** The commission rate, the waiver and its start, and the all-time waived / charged totals. */
  app.get("/admin/commission-terms", { ...gate, schema: SCHEMAS.terms }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await termsBody(prisma));
  });

  /**
   * Saves the rate and the waiver. Waiver on: trips completed from the start
   * day owe nothing (and drivers are shown nothing owed). Off: trips from now
   * on are charged at the rate, automatically.
   */
  app.put("/admin/commission-terms", { ...gate, schema: SCHEMAS.saveTerms, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { rateBps: number; waived: boolean; waivedFromDay?: string | null };
    const input = { rateBps: body.rateBps, waived: body.waived, waivedFromDay: body.waivedFromDay ?? null };
    const problem = commissionTermsProblem(input);
    if (problem) return reply.code(400).send({ error: problem });
    await saveCommissionTerms(prisma, input, request.user!.userId);
    clearAdminCache();
    return reply.send(await termsBody(prisma));
  });

  /** The period's top-ups, and fares − commission + top-ups per driver and per day. */
  app.get("/admin/payouts", { ...gate, schema: SCHEMAS.payouts }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    return reply.send(await cached(`payouts:${periodKey(p)}`, () => payoutsReport(prisma, p)));
  });

  /** Records a top-up paid to a driver (by Driver.id or User.id). */
  app.post("/admin/payouts", { ...gate, schema: SCHEMAS.recordTopUp, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { driverId: string; amountPesewas: number; paidOn: string; method: TopUpMethod; note?: string | null };
    const driver = await prisma.driver.findFirst({ where: { OR: [{ id: body.driverId }, { userId: body.driverId }] }, select: { userId: true } });
    if (!driver) return reply.code(404).send({ error: "Driver not found" });
    try {
      const row = await recordTopUp(
        prisma,
        { driverUserId: driver.userId, amountPesewas: body.amountPesewas, paidOnDay: body.paidOn, method: body.method, note: body.note ?? null },
        request.user!.userId,
      );
      return reply.code(201).send({ topUp: { id: row.id, amountPesewas: row.amountPesewas } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Removes a top-up recorded by mistake. A reason is required; the row is kept, marked removed. */
  app.post("/admin/payouts/:id/remove", { ...gate, schema: SCHEMAS.removeTopUp, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      const row = await removeTopUp(prisma, (request.params as { id: string }).id, (request.body as { reason: string }).reason, request.user!.userId);
      return reply.send({ topUp: { id: row.id, removedAt: row.removedAt?.toISOString() ?? null } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** For each Settings section: when it was last changed, and by whom (from the audit log). */
  app.get("/admin/settings/changes", { ...gate, schema: SCHEMAS.settingsChanges }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const entries = await Promise.all(
      Object.entries(SETTINGS_SECTIONS).map(async ([section, actions]) => {
        const row = await prisma.adminAuditLog.findFirst({ where: { action: { in: [...actions] } }, orderBy: { timestamp: "desc" }, select: { actor: true, action: true, timestamp: true } });
        return [section, row] as const;
      }),
    );
    const actorIds = [...new Set(entries.map(([, r]) => r?.actor).filter((x): x is string => Boolean(x)))];
    const names = new Map((await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return reply.send({
      sections: Object.fromEntries(
        entries.map(([section, r]) => [section, r ? { at: r.timestamp.toISOString(), action: r.action, by: names.get(r.actor) ?? "Unknown admin" } : null]),
      ),
    });
  });
}
