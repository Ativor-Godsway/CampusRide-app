import type { FastifyInstance } from "fastify";
import { useRequestValidation } from "../http/validation";
import type { PrismaClient } from "@prisma/client";
import {
  PLACES_ATTRIBUTION,
  SERVICE_AREA_POLYGON,
  isInServiceArea,
  outsideServiceAreaMessage,
  placeNote,
  routeAttribution,
  searchPlaces,
  type PathPoint,
} from "@rida/shared";
import { requireAuth } from "../middleware/auth";
import { getActivePlaces } from "../services/places/placeCache";
import { CAMPUS_PROVIDER, MAX_ROUTE_POINTS, routeThroughPoints } from "../services/routing/campusRoutes";
import { RULES } from "../rateLimit/rules";
import { MAX, integer, latitude, longitude, noInput, object, text } from "../http/schemas";

/** What the apps get for a place: no internal columns (source, timestamps). */
function placeForApp(p: {
  id: string;
  name: string;
  aliases: string[];
  latitude: number;
  longitude: number;
  category: string;
  zoneId: string;
  source: string | null;
}) {
  return {
    id: p.id,
    name: p.name,
    aliases: p.aliases,
    latitude: p.latitude,
    longitude: p.longitude,
    category: p.category,
    zoneId: p.zoneId,
    note: placeNote(p.source),
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
  useRequestValidation(app);
  app.get("/places", { onRequest: requireAuth, schema: noInput }, async (_request, reply) => {
    const places = await getActivePlaces(prisma);
    return reply.code(200).send({ places: places.map(placeForApp), attribution: PLACES_ATTRIBUTION });
  });

  app.get(
    "/places/search",
    { onRequest: requireAuth, schema: { querystring: object({ q: text(MAX.query), limit: integer(1, 100) }) } },
    async (request, reply) => {
    const { q, limit } = (request.query ?? {}) as { q?: unknown; limit?: unknown };
    const query = typeof q === "string" ? q.slice(0, 80) : "";
    const n = Math.min(Math.max(Number(limit) || 8, 1), 20);
    const places = searchPlaces(await getActivePlaces(prisma), query, n);
    return reply.code(200).send({ places: places.map(placeForApp), attribution: PLACES_ATTRIBUTION });
  });

  app.get("/service-area", { onRequest: requireAuth, schema: noInput }, async (_request, reply) => {
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
      onRequest: requireAuth,
      schema: {
        body: object(
          {
            points: {
              type: "array",
              minItems: 2,
              maxItems: MAX_ROUTE_POINTS,
              items: object({ latitude, longitude }, ["latitude", "longitude"]),
            },
          },
          ["points"],
        ),
      },
      // Per account (a route is cheap now, but an endless loop of them isn't).
      config: { limits: { user: [RULES.routeLegs] } },
    },
    async (request, reply) => {
      const points = parsePoints((request.body as { points?: unknown } | undefined)?.points);
      if (!points) {
        return reply.code(400).send({ error: `points must be 2 to ${MAX_ROUTE_POINTS} { latitude, longitude } pairs` });
      }
      if (!points.slice(1).every((p) => isInServiceArea(p))) {
        return reply.code(422).send({ error: outsideServiceAreaMessage("pickup"), code: "OUTSIDE_SERVICE_AREA" });
      }
      // On campus roads only (services/routing/campusRoutes.ts). No road near
      // a point, or no way between two: a clear refusal, never a route off
      // campus; the apps then draw a dashed straight line.
      const route = routeThroughPoints(points);
      if ("code" in route) return reply.code(422).send({ error: route.message, code: route.code });
      return reply.code(200).send({ ...route, attribution: routeAttribution(CAMPUS_PROVIDER) });
    },
  );
}
