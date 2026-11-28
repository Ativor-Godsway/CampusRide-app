import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { DEFAULT_WAIT_FEE_SETTINGS, WAIT_FEE_BOUNDS, waitFeeSettingsProblem, type WaitFeeSettings } from "@rida/shared";
import { DEFAULT_SEARCH_WINDOW_SECONDS, SEARCH_WINDOW_BOUNDS_SECONDS, searchWindowProblem, DEFAULT_FARE_PRICES, FAR_ENDS, REFUSED_BOOKING_REASON_LABELS, farePricesProblem, type FarEnd, type FarePrices } from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { boolean, id, integer, noInput, object, oneOf, text } from "../http/schemas";
import { RULES } from "../rateLimit/rules";
import { config } from "../config";
import { cached, clearAdminCache } from "../services/admin/cache";
import { accraDay, daysIn, periodKey } from "../services/admin/period";
import { getFarePricing, saveFarePricing } from "../services/ride/farePricing";
import { refusedBookingCounts } from "../services/ride/refusedBookings";
import { readSearchWindow, saveMovingFirstSettings, saveSearchWindow } from "../services/ride/searchWindow";
import { readWaitFeeSettings, saveWaitFeeSettings, waitFeesByDay } from "../services/ride/waitFee";
import {
  ZoneNeighbourError,
  currentZoneNeighbours,
  replaceZoneNeighbours,
  suggestedZoneNeighbours,
} from "../services/zones/zoneNeighbours";
import { periodOr400 } from "./adminDashboard";

/**
 * Admin site, dispatch and pricing (2026-11-24):
 * - far-trip pricing: the two Shared prices and the places in each far end (Places page);
 * - zone neighbours: which zones dispatch treats as next door (Places page);
 * - refused bookings: anonymous counts per day and reason (Supply & demand).
 * Every change is audit-logged.
 */

const MAX_FAR_PLACES = 200;
const MAX_PAIRS = 500;
const pair = object({ a: id, b: id }, ["a", "b"]);

const SCHEMAS = {
  farPricing: noInput,
  saveFarPricing: {
    body: object(
      {
        sharedPesewas: integer(1, 100_000),
        shared2Pesewas: integer(1, 100_000),
        shared3Pesewas: integer(1, 100_000),
        farPerSeatPesewas: integer(0, 100_000),
        lonePesewas: integer(1, 100_000),
        // An admin page from before seat prices sends this instead of farPerSeatPesewas.
        sharedFarPesewas: integer(1, 100_000),
        farPlaces: { type: "array", maxItems: MAX_FAR_PLACES, items: object({ id, end: oneOf(FAR_ENDS) }, ["id", "end"]) },
      },
      ["sharedPesewas", "farPlaces"],
    ),
  },
  zoneNeighbours: noInput,
  saveZoneNeighbours: { body: object({ pairs: { type: "array", maxItems: MAX_PAIRS, items: pair } }, ["pairs"]) },
  refused: { querystring: object({ from: text(40), to: text(40) }, ["from", "to"]) },
  dispatchSettings: noInput,
  saveDispatchSettings: {
    body: object({ searchWindowSeconds: integer(1, 100_000), movingFirstEnabled: boolean, autoAddDefault: boolean }, ["searchWindowSeconds"]),
  },
  waitFeeSettings: noInput,
  saveWaitFeeSettings: {
    body: object(
      { freeWaitSeconds: integer(1, 100_000), feePesewas: integer(0, 100_000), noShowMinutes: integer(1, 1_000) },
      ["freeWaitSeconds", "feePesewas", "noShowMinutes"],
    ),
  },
  waitFees: { querystring: object({ from: text(40), to: text(40) }, ["from", "to"]) },
};

export function registerAdminDispatchRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const gate = { onRequest: [requireAuth, adminOnly] };
  const write = { limits: { user: [RULES.adminWrite] } };

  async function farPricingBody() {
    const [pricing, places] = await Promise.all([
      getFarePricing(prisma),
      prisma.place.findMany({
        where: { farEnd: { not: null } },
        select: { id: true, name: true, isActive: true, farEnd: true, zone: { select: { name: true } } },
        orderBy: { name: "asc" },
      }),
    ]);
    const admin = pricing.updatedBy
      ? await prisma.user.findUnique({ where: { id: pricing.updatedBy }, select: { id: true, name: true } })
      : null;
    return {
      settings: {
        sharedPesewas: pricing.sharedPesewas,
        shared2Pesewas: pricing.shared2Pesewas,
        shared3Pesewas: pricing.shared3Pesewas,
        farPerSeatPesewas: pricing.farPerSeatPesewas,
        lonePesewas: pricing.lonePesewas,
        // As an admin page from before seat prices reads them.
        sharedFarPesewas: pricing.sharedPesewas + pricing.farPerSeatPesewas,
        loneFarePesewas: pricing.lonePesewas,
        updatedAt: pricing.updatedAt?.toISOString() ?? null,
        updatedBy: admin,
      },
      defaults: { ...DEFAULT_FARE_PRICES, sharedFarPesewas: DEFAULT_FARE_PRICES.sharedPesewas + DEFAULT_FARE_PRICES.farPerSeatPesewas },
      farPlaces: places.map((p) => ({ id: p.id, name: p.name, isActive: p.isActive, zoneName: p.zone.name, end: p.farEnd! })),
    };
  }

  /** The prices (Shared by seats, far per seat, Ride alone) and the places in each far end (NORTH / SOUTH). */
  app.get("/admin/far-pricing", { ...gate, schema: SCHEMAS.farPricing }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await farPricingBody());
  });

  /** Saves both prices and exactly these far-end places. New requests use them at once; requested rides keep theirs. */
  app.put("/admin/far-pricing", { ...gate, schema: SCHEMAS.saveFarPricing, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as Partial<FarePrices> & {
      sharedPesewas: number;
      sharedFarPesewas?: number;
      farPlaces: Array<{ id: string; end: FarEnd }>;
    };
    // A price left out keeps today's (an admin page from before seat prices
    // sends only the 1-seat and far 1-seat prices).
    const now = await getFarePricing(prisma);
    const prices: FarePrices = {
      sharedPesewas: body.sharedPesewas,
      shared2Pesewas: body.shared2Pesewas ?? now.shared2Pesewas,
      shared3Pesewas: body.shared3Pesewas ?? now.shared3Pesewas,
      farPerSeatPesewas:
        body.farPerSeatPesewas ??
        (body.sharedFarPesewas !== undefined ? body.sharedFarPesewas - body.sharedPesewas : now.farPerSeatPesewas),
      lonePesewas: body.lonePesewas ?? now.lonePesewas,
    };
    const problem = farePricesProblem(prices);
    if (problem) return reply.code(400).send({ error: problem });
    const byId = new Map(body.farPlaces.map((p) => [p.id, p.end]));
    if (byId.size !== body.farPlaces.length) return reply.code(400).send({ error: "A place can be in one far end only." });
    const known = await prisma.place.count({ where: { id: { in: [...byId.keys()] } } });
    if (known !== byId.size) return reply.code(400).send({ error: "One of those places doesn't exist any more. Reload and try again." });
    await saveFarePricing(
      prisma,
      { ...prices, farPlaces: [...byId].map(([placeId, end]) => ({ placeId, end })) },
      request.user!.userId,
    );
    clearAdminCache();
    return reply.send(await farPricingBody());
  });

  async function neighboursBody() {
    const [zones, current, suggested] = await Promise.all([
      prisma.zone.findMany({ where: { retiredAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      currentZoneNeighbours(prisma),
      suggestedZoneNeighbours(prisma),
    ]);
    return {
      zones,
      pairs: current,
      suggested: suggested.map((p) => ({ a: p.a, b: p.b, centreMeters: p.centreMeters, borderMeters: p.borderMeters })),
    };
  }

  /** The zones in service, the neighbour pairs dispatch uses now, and the suggested ones (from where the zones are). */
  app.get("/admin/zone-neighbours", { ...gate, schema: SCHEMAS.zoneNeighbours }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await neighboursBody());
  });

  /** Makes the neighbour pairs exactly these (every zone needs at least one). */
  app.put("/admin/zone-neighbours", { ...gate, schema: SCHEMAS.saveZoneNeighbours, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { pairs } = request.body as { pairs: Array<{ a: string; b: string }> };
    try {
      await replaceZoneNeighbours(prisma, pairs, { adminId: request.user!.userId });
    } catch (err) {
      if (err instanceof ZoneNeighbourError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return reply.send(await neighboursBody());
  });

  async function dispatchSettingsBody() {
    const setting = await readSearchWindow(prisma);
    const admin = setting.updatedBy ? await prisma.user.findUnique({ where: { id: setting.updatedBy }, select: { id: true, name: true } }) : null;
    // Fill moving cars first: what the step did with live Shared requests, last 7 days (analysis).
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const steps = await prisma.ride.groupBy({
      by: ["movingStep"],
      where: { createdAt: { gte: since }, isReviewDemo: false, type: "SHARED", movingStep: { not: null } },
      _count: { _all: true },
    });
    return {
      settings: {
        searchWindowSeconds: setting.searchWindowSeconds,
        movingFirstEnabled: setting.movingFirstEnabled,
        autoAddDefault: setting.autoAddDefault,
        updatedAt: setting.updatedAt?.toISOString() ?? null,
        updatedBy: admin,
      },
      defaults: { searchWindowSeconds: DEFAULT_SEARCH_WINDOW_SECONDS, movingFirstEnabled: true, autoAddDefault: false },
      bounds: SEARCH_WINDOW_BOUNDS_SECONDS,
      /** How long a driver's offer pop-up lasts: set on the server (DRIVER_OFFER_SECONDS), shown read-only. */
      offerSeconds: config.driverOfferSeconds,
      movingSteps7d: Object.fromEntries(steps.map((r) => [r.movingStep!, r._count._all])),
    };
  }

  /** How long a request searches for a driver before "no driver found" (2026-11-25; 7 min by default). */
  app.get("/admin/dispatch-settings", { ...gate, schema: SCHEMAS.dispatchSettings }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await dispatchSettingsBody());
  });

  /** Saves it: requests already searching follow the new length too. Audit-logged. */
  app.put("/admin/dispatch-settings", { ...gate, schema: SCHEMAS.saveDispatchSettings, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { searchWindowSeconds, movingFirstEnabled, autoAddDefault } = request.body as {
      searchWindowSeconds: number;
      movingFirstEnabled?: boolean;
      autoAddDefault?: boolean;
    };
    const problem = searchWindowProblem(searchWindowSeconds);
    if (problem) return reply.code(400).send({ error: problem });
    const now = await readSearchWindow(prisma);
    if (now.searchWindowSeconds !== searchWindowSeconds) await saveSearchWindow(prisma, searchWindowSeconds, request.user!.userId);
    // An admin page from before the moving-car switches sends only the window: they stay as they are.
    const moving = { movingFirstEnabled: movingFirstEnabled ?? now.movingFirstEnabled, autoAddDefault: autoAddDefault ?? now.autoAddDefault };
    if (moving.movingFirstEnabled !== now.movingFirstEnabled || moving.autoAddDefault !== now.autoAddDefault) {
      await saveMovingFirstSettings(prisma, moving, request.user!.userId);
    }
    return reply.send(await dispatchSettingsBody());
  });

  async function waitFeeSettingsBody() {
    const setting = await readWaitFeeSettings(prisma);
    const admin = setting.updatedBy ? await prisma.user.findUnique({ where: { id: setting.updatedBy }, select: { id: true, name: true } }) : null;
    return {
      settings: {
        freeWaitSeconds: setting.freeWaitSeconds,
        feePesewas: setting.feePesewas,
        noShowMinutes: setting.noShowMinutes,
        updatedAt: setting.updatedAt?.toISOString() ?? null,
        updatedBy: admin,
      },
      defaults: DEFAULT_WAIT_FEE_SETTINGS,
      bounds: WAIT_FEE_BOUNDS,
    };
  }

  /** The pickup wait fee (2026-11-25, services/ride/waitFee.ts): free wait, fee, no-show wait. */
  app.get("/admin/wait-fee-settings", { ...gate, schema: SCHEMAS.waitFeeSettings }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await waitFeeSettingsBody());
  });

  /** Saves them for waits that start from now on (a wait already running keeps its own). Audit-logged. */
  app.put("/admin/wait-fee-settings", { ...gate, schema: SCHEMAS.saveWaitFeeSettings, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { freeWaitSeconds, feePesewas, noShowMinutes } = request.body as WaitFeeSettings;
    const next = { freeWaitSeconds, feePesewas, noShowMinutes };
    const problem = waitFeeSettingsProblem(next);
    if (problem) return reply.code(400).send({ error: problem });
    await saveWaitFeeSettings(prisma, next, request.user!.userId);
    clearAdminCache();
    return reply.send(await waitFeeSettingsBody());
  });

  /** Wait fees collected and no-shows in the period, per Accra day (Finances). */
  app.get("/admin/wait-fees", { ...gate, schema: SCHEMAS.waitFees }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`wait-fees:${periodKey(p)}`, () => waitFeesByDay(prisma, p, accraDay, daysIn(p)));
    return reply.send(body);
  });

  /** Refused bookings in the period: per Accra day and per reason (anonymous; services/ride/refusedBookings.ts). */
  app.get("/admin/refused-bookings", { ...gate, schema: SCHEMAS.refused }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`refused:${periodKey(p)}`, async () => {
      const [counts, zones] = await Promise.all([
        refusedBookingCounts(prisma, p, accraDay, daysIn(p)),
        prisma.zone.findMany({ select: { id: true, name: true } }),
      ]);
      const zoneName = new Map(zones.map((z) => [z.id, z.name]));
      return {
        ...counts,
        labels: REFUSED_BOOKING_REASON_LABELS,
        topPickupZones: counts.topPickupZones.map((z) => ({ ...z, name: z.zoneId ? (zoneName.get(z.zoneId) ?? null) : null })),
      };
    });
    return reply.send(body);
  });
}
