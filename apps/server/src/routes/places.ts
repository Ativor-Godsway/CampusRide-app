import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  PLACES_ATTRIBUTION,
  SERVICE_AREA_POLYGON,
  isInServiceArea,
  outsideServiceAreaMessage,
  routeAttribution,
  searchPlaces,
  type PathPoint,
} from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { getActivePlaces } from "../services/places/placeCache";
import { MAX_ROUTE_POINTS, routeThroughPoints } from "../services/routing/pointRoutes";

/** What the apps get for a place: no internal columns (source, timestamps). */
function placeForApp(p: {
  id: string;
  name: string;
  aliases: string[];
  latitude: number;
  longitude: number;
  category: string;
  zoneId: string;
}) {
  return {
    id: p.id,
    name: p.name,
    aliases: p.aliases,
    latitude: p.latitude,
    longitude: p.longitude,
    category: p.category,
    zoneId: p.zoneId,
  };
}

function parsePoints(raw: unknown): PathPoint[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_ROUTE_POINTS) return null;
  const points: PathPoint[] = [];
  for (const item of raw) {
    const { latitude, longitude } = (item ?? {}) as Record<string, unknown>;
    if (typeof latitude !== "number" || typeof longitude !== "number") return null;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    points.push({ latitude, longitude });
  }
  return points;
}

/**
 * Campus places, the service area, and road routes between exact points.
 *
 * - GET /places — every active place (a couple of hundred, small): the apps
 *   search them on the phone, instantly, with searchPlaces from @rida/shared.
 * - GET /places/search?q= — the same search done here, for clients that
 *   don't keep the list.
 * - GET /service-area — the polygon pickups and drop-offs must be inside.
 * - POST /routes/legs — the road through 2–10 points, for drawing a trip.
 *
 * Place coordinates are public campus landmarks, not anyone's position.
 */
export function registerPlaceRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.get("/places", { preHandler: requireAuth }, async (_request, reply) => {
    const places = await getActivePlaces(prisma);
    return reply.code(200).send({ places: places.map(placeForApp), attribution: PLACES_ATTRIBUTION });
  });

  app.get("/places/search", { preHandler: requireAuth }, async (request, reply) => {
    const { q, limit } = (request.query ?? {}) as { q?: unknown; limit?: unknown };
    const query = typeof q === "string" ? q.slice(0, 80) : "";
    const n = Math.min(Math.max(Number(limit) || 8, 1), 20);
    const places = searchPlaces(await getActivePlaces(prisma), query, n);
    return reply.code(200).send({ places: places.map(placeForApp), attribution: PLACES_ATTRIBUTION });
  });

  app.get("/service-area", { preHandler: requireAuth }, async (_request, reply) => {
    return reply.code(200).send({
      polygon: SERVICE_AREA_POLYGON.map(([latitude, longitude]) => ({ latitude, longitude })),
      message: outsideServiceAreaMessage("pickup"),
    });
  });

  /**
   * Body: `{ points: [{ latitude, longitude }, …] }`, 2–10 of them. Every
   * point after the first must be inside the service area; the first may be
   * a driver's live position, which can be just outside it. The caller
   * sends its own points (a rider their pins, a driver their position and
   * their trip's stops), so nothing here reveals anyone else's location.
   */
  app.post(
    "/routes/legs",
    {
      preHandler: requireAuth,
      config: {
        rateLimit: {
          max: config.rateLimit.routeLegsMax,
          timeWindow: "15 minutes",
          hook: "preHandler" as const,
          keyGenerator: (request: FastifyRequest) => `user:${request.user?.userId ?? request.ip}`,
        },
      },
    },
    async (request, reply) => {
      const points = parsePoints((request.body as { points?: unknown } | undefined)?.points);
      if (!points) {
        return reply.code(400).send({ error: `points must be 2 to ${MAX_ROUTE_POINTS} { latitude, longitude } pairs` });
      }
      if (!points.slice(1).every((p) => isInServiceArea(p))) {
        return reply.code(422).send({ error: outsideServiceAreaMessage("pickup"), code: "OUTSIDE_SERVICE_AREA" });
      }
      const route = await routeThroughPoints(prisma, points);
      // The fallback draws the stored zone roads, which also came from OSRM.
      return reply.code(200).send({ ...route, attribution: routeAttribution("osrm") });
    },
  );
}
