import type { FastifyInstance, FastifyReply } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { maskPhone, redactText } from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { integer, noInput, object, text } from "../http/schemas";
import { config } from "../config";
import { normalizePhone } from "../lib/phone";
import { launchStatus } from "../services/launch/launchSettings";
import { reviewDemoConfig } from "../services/reviewDemo/config";
import { cached } from "../services/admin/cache";
import { driverBalances } from "../services/admin/cash";
import { gotDriver, loadCompletedTrips, loadRequests, loadSessions, noDriverFound, zoneNames } from "../services/admin/facts";
import { driversOnlineByHour } from "../services/admin/metrics";
import { accraHour, parsePeriod, periodKey, weekEarlier, type Period } from "../services/admin/period";
import { RIDE_ROW_SELECT, rideRow } from "../services/admin/rows";
import { liveSnapshot } from "../services/admin/liveBoard";

/**
 * The admin dashboard v2 (apps/admin): the sidebar badges, global search,
 * Overview, Live map, Settings' read-only system facts and the audit log.
 * ADMIN accounts on ADMIN_PHONE_ALLOWLIST only (adminOnly + requireAdmin),
 * like every /admin route. Every number follows docs/admin-metrics.md.
 *
 * Cost: aggregates are cached for 60 s per question (services/admin/cache.ts),
 * and the live map reads the server's memory (services/admin/liveBoard.ts),
 * so the dashboard never asks the database more than once a minute per page.
 */

/** When the process started: on Render, the last deploy (or restart). */
const STARTED_AT = new Date();

const period = { from: text(40), to: text(40) };

const SCHEMAS = {
  summary: noInput,
  search: { querystring: object({ q: text(80, { nonEmpty: true }) }, ["q"]) },
  overview: { querystring: object(period, ["from", "to"]) },
  live: noInput,
  system: noInput,
  audit: {
    querystring: object({
      action: text(80),
      actor: text(64),
      q: text(120),
      page: integer(1, 10_000),
      pageSize: integer(1, 200),
    }),
  },
};

/** The period from the query, or a 400 already sent. */
export function periodOr400(query: unknown, reply: FastifyReply): Period | null {
  const parsed = parsePeriod((query ?? {}) as { from?: unknown; to?: unknown });
  if ("error" in parsed) {
    void reply.code(400).send({ error: parsed.error });
    return null;
  }
  return parsed;
}

/** Commission still owed by all drivers together (positive balances only). */
async function outstanding(prisma: PrismaClient): Promise<{ pesewas: number; drivers: number }> {
  const balances = await driverBalances(prisma);
  let pesewas = 0;
  let drivers = 0;
  for (const b of balances.values()) {
    if (b.balancePesewas > 0) {
      pesewas += b.balancePesewas;
      drivers += 1;
    }
  }
  return { pesewas, drivers };
}

async function databaseUp(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export function registerAdminDashboardRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const gate = { onRequest: [requireAuth, adminOnly] };

  /** The sidebar's badges and the top bar's launch mode pill. */
  app.get("/admin/summary", { ...gate, schema: SCHEMAS.summary }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const summary = await cached("summary", async () => {
      const [openSos, approvals, owed, launch, dbUp] = await Promise.all([
        prisma.sosEvent.count({ where: { handledAt: null } }),
        prisma.driver.count({ where: { isApproved: false, suspendedAt: null, user: { deletedAt: null, isReviewDemo: false } } }),
        outstanding(prisma),
        launchStatus(prisma),
        databaseUp(prisma),
      ]);
      return {
        openSos,
        driversNeedingApproval: approvals,
        cashOutstandingPesewas: owed.pesewas,
        launchMode: launch.mode,
        database: dbUp ? ("ok" as const) : ("down" as const),
        generatedAt: new Date().toISOString(),
      };
    });
    return reply.send(summary);
  });

  /**
   * The top bar's search: a phone number (rider or driver), a ride id, or a
   * driver's name or plate (riders by name too). At most 10 results, phones
   * masked. Not cached: it answers what was typed.
   */
  app.get("/admin/search", { ...gate, schema: SCHEMAS.search }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = String((request.query as { q: string }).q).trim();
    const results: Array<{ kind: "ride" | "rider" | "driver"; id: string; title: string; subtitle: string }> = [];

    const phone = normalizePhone(q);
    if (phone) {
      const user = await prisma.user.findUnique({
        where: { phone },
        select: { id: true, name: true, role: true, driver: { select: { id: true, plate: true } } },
      });
      if (user?.role === "DRIVER" && user.driver) {
        results.push({ kind: "driver", id: user.driver.id, title: user.name, subtitle: `Driver · ${user.driver.plate ?? "no plate"} · ${maskPhone(phone)}` });
      } else if (user?.role === "RIDER") {
        results.push({ kind: "rider", id: user.id, title: user.name, subtitle: `Rider · ${maskPhone(phone)}` });
      }
    }

    if (/^[a-z0-9]{6,40}$/i.test(q)) {
      const rides = await prisma.ride.findMany({
        where: { id: { startsWith: q }, isReviewDemo: false },
        select: { id: true, createdAt: true, rider: { select: { name: true } } },
        take: 3,
      });
      for (const r of rides) {
        results.push({ kind: "ride", id: r.id, title: `Ride ${r.id.slice(-6)}`, subtitle: `${r.rider.name} · ${r.createdAt.toISOString().slice(0, 10)}` });
      }
    }

    if (q.length >= 2) {
      const plate = q.replace(/[\s-]/g, "");
      const drivers = await prisma.driver.findMany({
        where: {
          user: { deletedAt: null, isReviewDemo: false },
          OR: [{ user: { name: { contains: q, mode: "insensitive" } } }, { plate: { contains: q, mode: "insensitive" } }, { plate: { contains: plate, mode: "insensitive" } }],
        },
        select: { id: true, plate: true, user: { select: { name: true } } },
        take: 5,
      });
      for (const d of drivers) {
        if (!results.some((r) => r.kind === "driver" && r.id === d.id)) {
          results.push({ kind: "driver", id: d.id, title: d.user.name, subtitle: `Driver · ${d.plate ?? "no plate"}` });
        }
      }
      const riders = await prisma.user.findMany({
        where: { role: "RIDER", deletedAt: null, isReviewDemo: false, name: { contains: q, mode: "insensitive" } },
        select: { id: true, name: true, phone: true },
        take: 5,
      });
      for (const r of riders) {
        if (!results.some((x) => x.kind === "rider" && x.id === r.id)) {
          results.push({ kind: "rider", id: r.id, title: r.name, subtitle: `Rider · ${maskPhone(r.phone)}` });
        }
      }
    }
    return reply.send({ results: results.slice(0, 10) });
  });

  /**
   * Overview for one period (the page asks for today, Accra time): requests
   * against the same period a week earlier, fares and CampusRide's 15% of
   * trips completed in it, requests and drivers online per hour, the
   * no-driver alert, and the latest rides.
   */
  app.get("/admin/overview", { ...gate, schema: SCHEMAS.overview }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`overview:${periodKey(p)}`, async () => {
      const now = new Date();
      const [requests, before, trips, sessions, owed, latest, zones] = await Promise.all([
        loadRequests(prisma, p),
        prisma.ride.count({ where: { createdAt: { gte: weekEarlier(p).from, lt: weekEarlier(p).to }, isReviewDemo: false } }),
        loadCompletedTrips(prisma, p),
        loadSessions(prisma, p),
        outstanding(prisma),
        prisma.ride.findMany({ where: { isReviewDemo: false }, select: RIDE_ROW_SELECT, orderBy: { createdAt: "desc" }, take: 8 }),
        zoneNames(prisma),
      ]);
      const perHour = new Array<number>(24).fill(0);
      for (const r of requests) perHour[accraHour(r.createdAt)]! += 1;

      const misses = requests.filter(noDriverFound);
      const byZone = new Map<string, number>();
      for (const m of misses) byZone.set(m.pickupZoneId, (byZone.get(m.pickupZoneId) ?? 0) + 1);
      const topZones = [...byZone.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => zones.get(id) ?? "Unknown zone");
      const hours = misses.map((m) => accraHour(m.createdAt));

      return {
        generatedAt: now.toISOString(),
        requests: { count: requests.length, previousCount: before, gotDriver: requests.filter(gotDriver).length },
        completed: {
          trips: trips.length,
          sharedTrips: trips.filter((t) => t.type === "SHARED").length,
          faresPesewas: trips.reduce((s, t) => s + t.farePesewas, 0),
          commissionPesewas: trips.reduce((s, t) => s + t.commissionPesewas, 0),
        },
        cashOutstandingPesewas: owed.pesewas,
        hourly: { requests: perHour, driversOnline: driversOnlineByHour(sessions, p, now) },
        noDriver: {
          count: misses.length,
          firstHour: hours.length ? Math.min(...hours) : null,
          lastHour: hours.length ? Math.max(...hours) : null,
          topZones,
        },
        latestRides: latest.map(rideRow),
      };
    });
    return reply.send(body);
  });

  /**
   * The live map, asked every 5 s while it is on screen: from memory, plus
   * a database read shared by everyone at most once a minute.
   */
  app.get("/admin/live", { ...gate, schema: SCHEMAS.live }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await liveSnapshot(prisma));
  });

  /** Settings' read-only facts: app minimum versions, review demo mode, this server's version. */
  app.get("/admin/system", { ...gate, schema: SCHEMAS.system }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const demo = reviewDemoConfig();
    const commit = process.env.RENDER_GIT_COMMIT ?? process.env.SENTRY_RELEASE ?? null;
    return reply.send({
      minVersions: config.appMinVersions,
      reviewDemo: { enabled: demo.enabled, problems: demo.problems },
      server: {
        commit: commit ? commit.slice(0, 12) : null,
        startedAt: STARTED_AT.toISOString(),
        environment: config.nodeEnv,
      },
    });
  });

  /**
   * The audit log, newest first, filtered by action (prefix), admin and
   * free text (target or reason). Who did it by name.
   */
  app.get("/admin/audit", { ...gate, schema: SCHEMAS.audit }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const query = request.query as { action?: string; actor?: string; q?: string; page?: number; pageSize?: number };
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: Prisma.AdminAuditLogWhereInput = {};
    if (query.action) where.action = { startsWith: query.action };
    if (query.actor) where.actor = query.actor;
    if (query.q) {
      where.OR = [
        { target: { contains: query.q, mode: "insensitive" } },
        { reason: { contains: query.q, mode: "insensitive" } },
      ];
    }
    const [rows, total, actions, adminList] = await Promise.all([
      prisma.adminAuditLog.findMany({ where, orderBy: { timestamp: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.adminAuditLog.count({ where }),
      cached("audit:actions", () =>
        prisma.adminAuditLog.groupBy({ by: ["action"], _count: true, orderBy: { action: "asc" } }).then((g) => g.map((a) => a.action)),
      ),
      // For the "by admin" filter: the admin accounts (a handful).
      prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    const actorIds = [...new Set(rows.map((r) => r.actor).filter((a) => a !== "unknown" && a !== "system"))];
    const admins = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
    const byId = new Map(admins.map((a) => [a.id, a]));
    return reply.send({
      entries: rows.map((r) => ({
        id: r.id,
        at: r.timestamp.toISOString(),
        action: r.action,
        actor: byId.get(r.actor) ?? null,
        // Older rows can hold a full phone number: masked here like everywhere else.
        target: redactText(r.target),
        reason: r.reason === null ? null : redactText(r.reason),
      })),
      actions,
      admins: adminList,
      total,
      page,
      pageSize,
    });
  });
}
