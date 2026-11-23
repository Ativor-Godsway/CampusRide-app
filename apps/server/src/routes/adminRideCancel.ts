import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { ADMIN_CANCEL_REASON_MAX } from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { id, idParams, object, text } from "../http/schemas";
import { RULES } from "../rateLimit/rules";
import { clearAdminCache } from "../services/admin/cache";
import { AdminCancelRefusedError, adminCancelRide, adminCancelSeat, isMergedRequest, type AdminCancelResult } from "../services/ride/cancels";
import { announceAdminCancel } from "../services/ride/cancelEvents";
import { isActivePassengerStatus } from "../services/ride/stateMachine";

/**
 * Admin cancels, from a ride's detail panel (services/ride/cancels.ts):
 *
 * - POST /admin/rides/:id/cancel { reason } — the whole ride, in any active
 *   status (searching, driver on the way, on the trip, stuck).
 * - POST /admin/rides/:id/seats/:seatId/cancel { reason } — one rider's seat
 *   in any status but dropped off. On a request that was merged into another
 *   car (whose leftover seat still reads "Waiting", with no driver), the
 *   rider's real seat in that car is cancelled too.
 *
 * A reason is required and both are audit-logged with it in the same
 * transaction ("ride.cancel" / "ride.seat.cancel": who, when, why). The
 * rider(s) and the driver are told; the car's freed seats are offered again.
 * Count against the admin's change limit.
 */

const reasonBody = object({ reason: text(ADMIN_CANCEL_REASON_MAX, { nonEmpty: true }) }, ["reason"]);
const SCHEMAS = {
  ride: { params: idParams, body: reasonBody },
  seat: { params: object({ id, seatId: id }, ["id", "seatId"]), body: reasonBody },
};
const write = { limits: { user: [RULES.adminWrite] } };

function refused(reply: FastifyReply, err: AdminCancelRefusedError) {
  return reply.code(err.code === "SEAT_NOT_FOUND" ? 404 : 409).send({ error: err.message, code: err.code });
}

export function registerAdminRideCancelRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const gate = { onRequest: [requireAuth, adminOnly] };

  const tell = (result: AdminCancelResult, scope: "seat" | "ride", log: FastifyInstance["log"]) => {
    clearAdminCache();
    announceAdminCancel(prisma, result, scope).catch((err) => log.error({ err, rideId: result.ride.id }, "admin cancel: follow-up failed"));
  };

  app.post("/admin/rides/:id/cancel", { ...gate, schema: SCHEMAS.ride, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id: rideId } = request.params as { id: string };
    const reason = (request.body as { reason: string }).reason.trim();
    if (!reason) return reply.code(400).send({ error: "Say why the ride is cancelled" });
    const exists = await prisma.ride.findFirst({ where: { id: rideId, isReviewDemo: false }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: "Ride not found" });
    let result;
    try {
      result = await adminCancelRide(prisma, { rideId, adminUserId: request.user!.userId, reason });
    } catch (err) {
      if (err instanceof AdminCancelRefusedError) return refused(reply, err);
      throw err;
    }
    request.log.warn({ event: "ride_cancelled_by_admin", rideId, seats: result.cancelledSeats.length }, "Admin cancelled a ride");
    reply.send({ status: result.ride.status, cancelledSeats: result.cancelledSeats.length });
    tell(result, "ride", request.log);
    return reply;
  });

  app.post("/admin/rides/:id/seats/:seatId/cancel", { ...gate, schema: SCHEMAS.seat, config: write }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id: rideId, seatId } = request.params as { id: string; seatId: string };
    const reason = (request.body as { reason: string }).reason.trim();
    if (!reason) return reply.code(400).send({ error: "Say why the seat is cancelled" });
    const ride = await prisma.ride.findFirst({
      where: { id: rideId, isReviewDemo: false },
      select: { id: true, riderId: true, status: true, cancelReason: true, mergedIntoRideId: true, passengers: { select: { id: true, riderId: true } } },
    });
    const seat = ride?.passengers.find((p) => p.id === seatId);
    if (!ride || !seat) return reply.code(404).send({ error: "Seat not found" });
    const adminUserId = request.user!.userId;

    let result;
    try {
      result = await adminCancelSeat(prisma, { rideId, seatId, adminUserId, reason });
    } catch (err) {
      if (err instanceof AdminCancelRefusedError) return refused(reply, err);
      throw err;
    }

    // The leftover seat of a merged request: the rider is really in (or
    // waiting for) the car it was added to — cancel that seat too.
    let followed: AdminCancelResult | null = null;
    if (isMergedRequest(ride) && seat.riderId === ride.riderId) {
      const car = await prisma.ride.findUnique({
        where: { id: ride.mergedIntoRideId! },
        select: { passengers: { select: { id: true, riderId: true, status: true } } },
      });
      const carSeat = car?.passengers.find((p) => p.riderId === seat.riderId && isActivePassengerStatus(p.status));
      if (carSeat) {
        try {
          followed = await adminCancelSeat(prisma, { rideId: ride.mergedIntoRideId!, seatId: carSeat.id, adminUserId, reason });
        } catch (err) {
          // Dropped off meanwhile: the leftover is still tidied.
          if (!(err instanceof AdminCancelRefusedError)) throw err;
        }
      }
    }

    request.log.warn({ event: "seat_cancelled_by_admin", rideId, seatId, followedRideId: followed ? ride.mergedIntoRideId : null }, "Admin cancelled a seat");
    reply.send({
      status: result.ride.status,
      changed: result.changed || (followed?.changed ?? false),
      ...(followed ? { alsoCancelledOnRideId: followed.ride.id, alsoCancelledRideStatus: followed.ride.status } : {}),
    });
    // The leftover of a merged request has no one to tell; the car's seat does.
    if (!isMergedRequest(ride)) tell(result, "seat", request.log);
    else clearAdminCache();
    if (followed) tell(followed, "seat", request.log);
    return reply;
  });
}
