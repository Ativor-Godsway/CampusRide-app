import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { DEFAULT_SHARED_FARE_PRICES, FAR_ENDS, PRICING, REFUSED_BOOKING_REASON_LABELS, sharedFarePricesProblem, type FarEnd } from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { id, integer, noInput, object, oneOf, text } from "../http/schemas";
import { RULES } from "../rateLimit/rules";
import { cached, clearAdminCache } from "../services/admin/cache";
import { accraDay, daysIn, periodKey } from "../services/admin/period";
import { getFarePricing, saveFarePricing } from "../services/ride/farePricing";
import { refusedBookingCounts } from "../services/ride/refusedBookings";
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
        sharedFarPesewas: integer(1, 100_000),
        farPlaces: { type: "array", maxItems: MAX_FAR_PLACES, items: object({ id, end: oneOf(FAR_ENDS) }, ["id", "end"]) },
      },
      ["sharedPesewas", "sharedFarPesewas", "farPlaces"],
    ),
  },
  zoneNeighbours: noInput,
  saveZoneNeighbours: { body: object({ pairs: { type: "array", maxItems: MAX_PAIRS, items: pair } }, ["pairs"]) },
  refused: { querystring: object({ from: text(40), to: text(40) }, ["from", "to"]) },
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
        sharedFarPesewas: pricing.sharedFarPesewas,
        loneFarePesewas: PRICING.LONE_FARE,
        updatedAt: pricing.updatedAt?.toISOString() ?? null,
        updatedBy: admin,
      },
      defaults: DEFAULT_SHARED_FARE_PRICES,
      farPlaces: places.map((p) => ({ id: p.id, name: p.name, isActive: p.isActive, zoneName: p.zone.name, end: p.farEnd! })),
    };
  }

  /** The Shared prices (normal, far) and the places in each far end (NORTH / SOUTH). */
  app.get("/admin/far-pricing", { ...gate, schema: SCHEMAS.farPricing }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await farPricingBody());
  });

  /** Saves both prices and exactly these far-end places. New requests use them at once; requested rides keep theirs. */
  app.put("/admin/far-pricing", { ...gate, schema: SCHEMAS.saveFarPricing, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { sharedPesewas: number; sharedFarPesewas: number; farPlaces: Array<{ id: string; end: FarEnd }> };
    const problem = sharedFarePricesProblem(body);
    if (problem) return reply.code(400).send({ error: problem });
    const byId = new Map(body.farPlaces.map((p) => [p.id, p.end]));
    if (byId.size !== body.farPlaces.length) return reply.code(400).send({ error: "A place can be in one far end only." });
    const known = await prisma.place.count({ where: { id: { in: [...byId.keys()] } } });
    if (known !== byId.size) return reply.code(400).send({ error: "One of those places doesn't exist any more. Reload and try again." });
    await saveFarePricing(
      prisma,
      { sharedPesewas: body.sharedPesewas, sharedFarPesewas: body.sharedFarPesewas, farPlaces: [...byId].map(([placeId, end]) => ({ placeId, end })) },
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
