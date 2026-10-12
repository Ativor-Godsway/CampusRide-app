import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";

/**
 * Read-only campus zone list, used by the rider/driver apps to populate the
 * pickup/dropoff pickers and map markers. Zones are seeded once (Phase 0)
 * and rarely change.
 *
 * Only zones in service: a retired zone (Zone.retiredAt) is never offered to
 * a rider or worked out as a driver's zone. Old rides that reference one get
 * its name from their own ride data, not from this list.
 */
export function registerZoneRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.get("/zones", { preHandler: requireAuth }, async (_request, reply) => {
    const zones = await prisma.zone.findMany({
      where: { retiredAt: null },
      select: { id: true, name: true, quadrant: true, latitude: true, longitude: true },
      orderBy: { name: "asc" },
    });
    return reply.code(200).send({ zones });
  });

  /**
   * Every precomputed road route between two zones (src/scripts/
   * precomputeZoneRoutes.ts) — at most 210 short encoded polylines, fetched
   * once per app session. An empty list is normal before the precompute has
   * run; the apps then draw straight lines.
   */
  app.get("/zones/routes", { preHandler: requireAuth }, async (_request, reply) => {
    const routes = await prisma.zoneRoute.findMany({
      where: { fromZone: { retiredAt: null }, toZone: { retiredAt: null } },
      select: { fromZoneId: true, toZoneId: true, polyline: true, distanceMeters: true, durationSeconds: true, provider: true },
    });
    return reply.code(200).send({ routes });
  });
}
