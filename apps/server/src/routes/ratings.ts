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
 * Phase 5c: a rider rates their driver after a COMPLETED ride. Upserts so a
 * rider can correct their rating; one row per (ride, rater, ratee).
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
}
