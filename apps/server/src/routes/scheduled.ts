import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_SCHEDULE_SETTINGS,
  SCHEDULE_ACCEPTED_VIA,
  SCHEDULE_PATHS,
  SCHEDULE_SETTING_FIELDS,
  isValidBookingSeats,
  parsePickupNote,
  scheduleSettingsProblem,
  type ScheduleAcceptedVia,
  type ScheduleSettings,
} from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { bodyOptional, boolean, empty, id, idParams, integer, noInput, object, oneOf, text } from "../http/schemas";
import { RULES } from "../rateLimit/rules";
import { OutsideServiceAreaError, PlaceNotFoundError, parseRideEndInput, resolveRideEnd, type RideEndInput } from "../services/places/rideEnds";
import { FareChangedError, quoteFares } from "../services/ride/farePricing";
import { TripTooShortError } from "../services/ride/createRide";
import { LaunchNotOpenError } from "../services/launch/launchSettings";
import { ScheduleError, groupable } from "../services/scheduled/core";
import { bookScheduledSeat, cancelScheduledBooking, markComing } from "../services/scheduled/booking";
import { acceptScheduledCar, driverCancelScheduledCar } from "../services/scheduled/dispatch";
import { driverSchedule, riderBookingView, riderUpcomingBooking, scheduleOptionsFor } from "../services/scheduled/views";
import { readScheduleSettingsRow, saveScheduleSettings } from "../services/scheduled/settings";
import { scheduledDayForAdmin } from "../services/scheduled/admin";

/**
 * Scheduled Shared rides (2026-11-27): the rider's schedule screen, booking,
 * card, cancel and "I'm coming"; the driver's Schedule tab, accept and give
 * back; the admin's day view and settings. Rules: @rida/shared
 * rides/scheduled.ts; the work: services/scheduled.
 */

const rideEnd = object({ placeId: id, latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 } });
const settingsBody = object(
  {
    enabled: boolean,
    introEnabled: boolean,
    ...Object.fromEntries(SCHEDULE_SETTING_FIELDS.map((f) => [f.key, integer(0, 100_000)])),
  },
  ["enabled", ...SCHEDULE_SETTING_FIELDS.map((f) => f.key)],
);

const SCHEMAS = {
  options: { body: object({ pickup: rideEnd, dropoff: rideEnd, seats: integer(1, 3) }, ["pickup", "dropoff"]) },
  book: {
    body: object(
      {
        arriveBy: text(40),
        pickup: rideEnd,
        dropoff: rideEnd,
        seats: integer(1, 3),
        shownFarePesewas: integer(0, 1_000_000),
        pickupNote: text(200, { nullable: true }),
        carId: id,
      },
      ["arriveBy", "pickup", "dropoff"],
    ),
  },
  mine: noInput,
  bookingAction: { params: idParams, body: empty },
  driverList: noInput,
  accept: { params: idParams, body: object({ source: oneOf(SCHEDULE_ACCEPTED_VIA) }) },
  driverCancel: { params: idParams, body: empty },
  adminDay: { querystring: object({ day: text(10) }) },
  adminSettings: noInput,
  saveSettings: { body: settingsBody },
};

function role(request: { user?: { role: string } | null }, reply: FastifyReply, wanted: "RIDER" | "DRIVER"): boolean {
  if (request.user?.role === wanted) return true;
  reply.code(403).send({ error: `${wanted === "RIDER" ? "Rider" : "Driver"} role required` });
  return false;
}

/** The refusals a scheduled-ride action can end with, as the apps read them. Anything else is rethrown. */
function refuse(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ScheduleError) return reply.code(err.status).send({ error: err.message, code: err.code, ...err.extra });
  if (err instanceof FareChangedError) return reply.code(422).send({ error: err.message, code: err.code, farePesewas: err.farePesewas });
  if (err instanceof LaunchNotOpenError) return reply.code(422).send({ error: err.message, code: err.code, launchAt: err.launchAt.toISOString() });
  if (err instanceof OutsideServiceAreaError) return reply.code(422).send({ error: err.message, code: err.code, end: err.end });
  if (err instanceof PlaceNotFoundError) return reply.code(404).send({ error: err.message, code: err.code, end: err.end });
  if (err instanceof TripTooShortError) return reply.code(400).send({ error: err.message, code: err.code });
  throw err;
}

function ends(body: { pickup?: unknown; dropoff?: unknown }): { pickup: RideEndInput; dropoff: RideEndInput } | { error: string } {
  const pickup = parseRideEndInput(body.pickup, "pickup");
  const dropoff = parseRideEndInput(body.dropoff, "dropoff");
  for (const parsed of [pickup, dropoff]) if (parsed && "error" in parsed) return { error: parsed.error };
  if (!pickup || !dropoff) return { error: "pickup and dropoff are required" };
  return { pickup: pickup as RideEndInput, dropoff: dropoff as RideEndInput };
}

export function registerScheduledRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const signedIn = { onRequest: requireAuth };

  // ─── Rider ────────────────────────────────────────────────────────────────

  /** The schedule screen for a trip: slots today and tomorrow, cars going the rider's way, the prices for 1–3 seats. */
  app.post(SCHEDULE_PATHS.options, { ...signedIn, schema: SCHEMAS.options }, async (request, reply) => {
    if (!role(request, reply, "RIDER")) return;
    const body = request.body as { pickup?: unknown; dropoff?: unknown; seats?: number };
    const trip = ends(body);
    if ("error" in trip) return reply.code(400).send({ error: trip.error });
    const seats = body.seats ?? 1;
    try {
      const [from, to] = await Promise.all([resolveRideEnd(prisma, "pickup", trip.pickup), resolveRideEnd(prisma, "dropoff", trip.dropoff)]);
      const quote = await quoteFares(prisma, from, to);
      const candidate = groupable({
        pickupZoneId: from.zoneId,
        pickupLat: from.latitude,
        pickupLng: from.longitude,
        dropoffZoneId: to.zoneId,
        dropoffLat: to.latitude,
        dropoffLng: to.longitude,
        seats,
      });
      const options = await scheduleOptionsFor(prisma, { riderId: request.user!.userId, candidate, sharedBySeats: quote.sharedBySeats, farTrip: quote.farTrip });
      return reply.header("cache-control", "no-store").send(options);
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Books seats for an arrive-by time (joins a car going the same way, or starts one). */
  app.post(SCHEDULE_PATHS.book, { ...signedIn, schema: SCHEMAS.book, config: { limits: { user: [RULES.rideCreate] } } }, async (request, reply) => {
    if (!role(request, reply, "RIDER")) return;
    const body = request.body as { arriveBy: string; pickup?: unknown; dropoff?: unknown; seats?: number; shownFarePesewas?: number; pickupNote?: unknown; carId?: string };
    const trip = ends(body);
    if ("error" in trip) return reply.code(400).send({ error: trip.error });
    const arriveBy = new Date(body.arriveBy);
    if (Number.isNaN(arriveBy.getTime())) return reply.code(400).send({ error: "arriveBy must be a time" });
    const seats = body.seats ?? 1;
    if (!isValidBookingSeats("SHARED", seats)) return reply.code(400).send({ error: "A Shared booking is for 1 to 3 seats.", code: "INVALID_SEATS" });
    const note = parsePickupNote(body.pickupNote);
    if (!note.ok) return reply.code(400).send({ error: note.error, code: "NOTE_TOO_LONG" });
    try {
      const booking = await bookScheduledSeat(prisma, {
        riderId: request.user!.userId,
        arriveBy,
        pickup: trip.pickup,
        dropoff: trip.dropoff,
        seats,
        shownFare: body.shownFarePesewas,
        pickupNote: note.note,
        carId: body.carId ?? null,
      });
      const full = await prisma.scheduledBooking.findUniqueOrThrow({ where: { id: booking.id }, include: { car: { include: { bookings: true } } } });
      return reply.code(201).send({ booking: await riderBookingView(prisma, full) });
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** The rider's upcoming scheduled ride (Home card), and whether the intro may show. */
  app.get(SCHEDULE_PATHS.mine, { ...signedIn, schema: SCHEMAS.mine }, async (request, reply) => {
    if (!role(request, reply, "RIDER")) return;
    const riderId = request.user!.userId;
    const [booking, settings, everBooked] = await Promise.all([
      riderUpcomingBooking(prisma, riderId),
      readScheduleSettingsRow(prisma),
      prisma.scheduledBooking.count({ where: { riderId } }),
    ]);
    return reply.header("cache-control", "no-store").send({
      booking,
      enabled: settings.enabled,
      intro: { show: settings.enabled && settings.introEnabled && everBooked === 0 },
    });
  });

  /** Cancel: free until 30 minutes before, then a strike. */
  app.post(
    "/rides/scheduled/:id/cancel",
    { ...signedIn, preValidation: bodyOptional, schema: SCHEMAS.bookingAction, config: { limits: { user: [RULES.rideCancel] } } },
    async (request, reply) => {
      if (!role(request, reply, "RIDER")) return;
      try {
        const result = await cancelScheduledBooking(prisma, request.user!.userId, (request.params as { id: string }).id);
        return reply.send({ cancelled: true, strike: result.strike, blockedUntil: result.blockedUntil?.toISOString() ?? null });
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  /** "I'm coming". */
  app.post("/rides/scheduled/:id/coming", { ...signedIn, preValidation: bodyOptional, schema: SCHEMAS.bookingAction }, async (request, reply) => {
    if (!role(request, reply, "RIDER")) return;
    try {
      await markComing(prisma, request.user!.userId, (request.params as { id: string }).id);
      return reply.send({ coming: true });
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // ─── Driver ───────────────────────────────────────────────────────────────

  /** The Schedule tab: my scheduled trips, then open scheduled cars by time. */
  app.get(SCHEDULE_PATHS.driver, { ...signedIn, schema: SCHEMAS.driverList }, async (request, reply) => {
    if (!role(request, reply, "DRIVER")) return;
    return reply.header("cache-control", "no-store").send(await driverSchedule(prisma, request.user!.userId));
  });

  app.post(
    "/driver/scheduled/:id/accept",
    { ...signedIn, preValidation: bodyOptional, schema: SCHEMAS.accept, config: { limits: { user: [RULES.driverAccept] } } },
    async (request, reply) => {
      if (!role(request, reply, "DRIVER")) return;
      const source = ((request.body ?? {}) as { source?: ScheduleAcceptedVia }).source ?? null;
      try {
        await acceptScheduledCar(prisma, request.user!.userId, (request.params as { id: string }).id, source);
        return reply.send(await driverSchedule(prisma, request.user!.userId));
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  /** Give an accepted car back (before it starts): it's Open again and riders are told. */
  app.post("/driver/scheduled/:id/cancel", { ...signedIn, preValidation: bodyOptional, schema: SCHEMAS.driverCancel }, async (request, reply) => {
    if (!role(request, reply, "DRIVER")) return;
    try {
      await driverCancelScheduledCar(prisma, request.user!.userId, (request.params as { id: string }).id);
      return reply.send(await driverSchedule(prisma, request.user!.userId));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // ─── Admin ────────────────────────────────────────────────────────────────

  const gate = { onRequest: [requireAuth, adminOnly] };

  /** One Accra day of scheduled rides (default today), and the last 14 days' counts. */
  app.get("/admin/scheduled", { ...gate, schema: SCHEMAS.adminDay }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { day } = (request.query ?? {}) as { day?: string };
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return reply.code(400).send({ error: "day must be YYYY-MM-DD" });
    return reply.send(await scheduledDayForAdmin(prisma, day ?? null));
  });

  async function settingsBodyOut() {
    const row = await readScheduleSettingsRow(prisma);
    const admin = row.updatedBy ? await prisma.user.findUnique({ where: { id: row.updatedBy }, select: { id: true, name: true } }) : null;
    const { updatedAt, updatedBy: _by, ...settings } = row;
    return { settings: { ...settings, updatedAt: updatedAt?.toISOString() ?? null, updatedBy: admin }, defaults: DEFAULT_SCHEDULE_SETTINGS, fields: SCHEDULE_SETTING_FIELDS };
  }

  app.get("/admin/schedule-settings", { ...gate, schema: SCHEMAS.adminSettings }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await settingsBodyOut());
  });

  /** Saves every number at once. Audit-logged (`schedule.settings`). Cars already booked follow the new numbers from the next tick. */
  app.put("/admin/schedule-settings", { ...gate, schema: SCHEMAS.saveSettings, config: { limits: { user: [RULES.adminWrite] } } }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as ScheduleSettings;
    const next = { ...DEFAULT_SCHEDULE_SETTINGS, ...body, introEnabled: body.introEnabled ?? true } as ScheduleSettings;
    const problem = scheduleSettingsProblem(next);
    if (problem) return reply.code(400).send({ error: problem });
    await saveScheduleSettings(prisma, next, request.user!.userId);
    return reply.send(await settingsBodyOut());
  });
}
