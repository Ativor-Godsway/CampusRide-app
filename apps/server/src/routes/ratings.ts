import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";

function isStars(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Phase 5c: a rider rates their driver after a COMPLETED ride.
 * Phase 4: a driver rates a rider, on the same model and the same rules.
 *
 * Both upsert, so either party can correct a rating; one row per
 * (ride, rater, ratee), which the schema enforces.
 */
export function registerRatingRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.post("/ratings", { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body as { rideId?: unknown; stars?: unknown; comment?: unknown };

    if (!isNonEmptyString(body.rideId) || !isStars(body.stars)) {
      return reply.code(400).send({ error: "rideId and stars (1-5) are required" });
    }
    const comment = typeof body.comment === "string" ? body.comment : null;

    const ride = await prisma.ride.findUnique({
      where: { id: body.rideId },
      include: { passengers: true },
    });
    if (!ride) {
      return reply.code(404).send({ error: "Ride not found" });
    }

    const raterId = request.user!.userId;
    const isRider = ride.riderId === raterId;
    const isPassenger = ride.passengers.some((p) => p.riderId === raterId);
    if (!isRider && !isPassenger) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (ride.status !== "COMPLETED") {
      return reply.code(409).send({ error: "Ride is not completed yet" });
    }
    if (!ride.driverId) {
      return reply.code(409).send({ error: "Ride has no driver to rate" });
    }

    const rating = await prisma.rating.upsert({
      where: {
        rideId_raterId_rateeId: { rideId: ride.id, raterId, rateeId: ride.driverId },
      },
      update: { stars: body.stars, comment },
      create: { rideId: ride.id, raterId, rateeId: ride.driverId, stars: body.stars, comment },
    });

    return reply.code(201).send({ rating });
  });

  /**
   * Phase 4 — the other direction: the ride's DRIVER rates one of its riders
   * after completion.
   *
   * A separate route rather than an overload of POST /ratings, because the
   * two differ in who may call them and, crucially, in who the ratee is: a
   * rider's target is unambiguous (the one driver), while a driver on a
   * SHARED ride has up to four riders and must say which one. `riderId` is
   * therefore required and validated against the ride's manifest — a driver
   * cannot rate someone who was not on the trip.
   */
  app.post("/ratings/rider", { preHandler: requireAuth }, async (request, reply) => {
    if (request.user?.role !== "DRIVER") {
      return reply.code(403).send({ error: "Driver role required" });
    }

    const body = request.body as {
      rideId?: unknown;
      riderId?: unknown;
      stars?: unknown;
      comment?: unknown;
    };

    if (!isNonEmptyString(body.rideId) || !isNonEmptyString(body.riderId) || !isStars(body.stars)) {
      return reply
        .code(400)
        .send({ error: "rideId, riderId and stars (1-5) are required" });
    }
    const comment = typeof body.comment === "string" ? body.comment : null;

    const ride = await prisma.ride.findUnique({
      where: { id: body.rideId },
      include: { passengers: true },
    });
    if (!ride) {
      return reply.code(404).send({ error: "Ride not found" });
    }

    const raterId = request.user.userId;
    if (ride.driverId !== raterId) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (ride.status !== "COMPLETED") {
      return reply.code(409).send({ error: "Ride is not completed yet" });
    }

    // The ride owner counts even on a SHARED ride where they also appear as a
    // passenger row; checking both covers LONE rides, which have no
    // RidePassenger row at all on the ride-level completion path.
    const rideeOnTrip =
      ride.riderId === body.riderId || ride.passengers.some((p) => p.riderId === body.riderId);
    if (!rideeOnTrip) {
      return reply.code(404).send({ error: "That rider was not on this ride" });
    }
    if (body.riderId === raterId) {
      return reply.code(400).send({ error: "Cannot rate yourself" });
    }

    const rating = await prisma.rating.upsert({
      where: {
        rideId_raterId_rateeId: { rideId: ride.id, raterId, rateeId: body.riderId },
      },
      update: { stars: body.stars, comment },
      create: { rideId: ride.id, raterId, rateeId: body.riderId, stars: body.stars, comment },
    });

    return reply.code(201).send({ rating });
  });

  /**
   * The riders a driver may rate for a completed ride, with whatever rating
   * the driver has already given. Lets the driver app show the rating prompt
   * without the client having to reconstruct the manifest itself.
   */
  app.get("/rides/:id/rateable-riders", { preHandler: requireAuth }, async (request, reply) => {
    if (request.user?.role !== "DRIVER") {
      return reply.code(403).send({ error: "Driver role required" });
    }

    const { id: rideId } = request.params as { id: string };
    const raterId = request.user.userId;

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { passengers: true },
    });
    if (!ride) return reply.code(404).send({ error: "Ride not found" });
    if (ride.driverId !== raterId) return reply.code(403).send({ error: "Forbidden" });
    if (ride.status !== "COMPLETED") {
      return reply.code(409).send({ error: "Ride is not completed yet" });
    }

    const riderIds = Array.from(
      new Set([ride.riderId, ...ride.passengers.map((p) => p.riderId)]),
    ).filter((id) => id !== raterId);

    const [users, existing] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: riderIds } },
        select: { id: true, name: true },
      }),
      prisma.rating.findMany({ where: { rideId, raterId }, select: { rateeId: true, stars: true } }),
    ]);

    const byRatee = new Map(existing.map((r) => [r.rateeId, r.stars]));

    return reply.code(200).send({
      riders: users.map((u) => ({
        riderId: u.id,
        name: u.name,
        stars: byRatee.get(u.id) ?? null,
      })),
    });
  });
}
