import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { RIDER_CANCEL_REASON_LABELS } from "@rida/shared";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { idParams, noInput, object, oneOf, text } from "../http/schemas";
import { config } from "../config";
import { seatFare } from "../services/ride/fares";
import { estimateRoute } from "../services/routing/campusRoutes";
import { cached } from "../services/admin/cache";
import {
  cancelledBy,
  gotDriver,
  gotDriverAt,
  loadCompletedTrips,
  loadRequests,
  loadSessions,
  noDriverFound,
  zoneNames,
} from "../services/admin/facts";
import { median, onlineMsByHourOfDay, ratio, supplySuggestion, zoneVerdicts } from "../services/admin/metrics";
import { accraHour, accraWeekday, periodKey, weekEarlier } from "../services/admin/period";
import { RIDE_ROW_SELECT, listPhone, rideRow } from "../services/admin/rows";
import { periodOr400 } from "./adminDashboard";

/**
 * Admin dashboard v2: one ride in full, Supply & demand, Cancellations and
 * where rides start and end (Places). Definitions: docs/admin-metrics.md.
 * Aggregates are cached for 60 s per period (services/admin/cache.ts).
 */

const period = { from: text(40), to: text(40) };
const WHO = ["rider", "driver", "system"] as const;

const SCHEMAS = {
  ride: { params: idParams, querystring: noInput.querystring },
  supply: { querystring: object(period, ["from", "to"]) },
  cancellations: { querystring: object({ ...period, who: oneOf(WHO) }, ["from", "to"]) },
  placesActivity: { querystring: object(period, ["from", "to"]) },
};

const SYSTEM_CANCEL_LABELS: Record<string, string> = {
  RIDER_CANCELLED: "Rider cancelled (no reason given)",
  DRIVER_BACKED_OUT: "Driver cancelled",
  NO_DRIVERS_AVAILABLE: "No driver found",
  ALL_PASSENGERS_LEFT: "Every rider left the car",
};

/** A grid cell for the map heat layer: about 55 m. */
const HEAT_GRID_DEG = 0.0005;

function cellOf(lat: number, lng: number): string {
  return `${Math.round(lat / HEAT_GRID_DEG)}:${Math.round(lng / HEAT_GRID_DEG)}`;
}

export function registerAdminInsightRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const gate = { onRequest: [requireAuth, adminOnly] };

  /**
   * One ride in full, for its detail panel: the timeline (requested, each
   * offer and its answer, matched, arrived, started, completed or cancelled
   * and by whom), its riders and what each pays, the route, ratings, SOS
   * and tracking links. Exact pins included (admins only).
   */
  app.get("/admin/rides/:id", { ...gate, schema: SCHEMAS.ride }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const ride = await prisma.ride.findFirst({
      where: { id, isReviewDemo: false },
      select: {
        ...RIDE_ROW_SELECT,
        matchedAt: true,
        noDriverFoundAt: true,
        departedAt: true,
        broadcastStartedAt: true,
        mergedIntoRideId: true,
        pickupLat: true,
        pickupLng: true,
        dropoffLat: true,
        dropoffLng: true,
        pickupNote: true,
        passengers: {
          select: {
            id: true,
            status: true,
            lockedFare: true,
            fareCharged: true,
            createdAt: true,
            arrivedAt: true,
            noShowAt: true,
            pickupLabel: true,
            dropoffLabel: true,
            pickupLat: true,
            pickupLng: true,
            dropoffLat: true,
            dropoffLng: true,
            rider: { select: { id: true, name: true, phone: true } },
            pickupZone: { select: { name: true } },
            dropoffZone: { select: { name: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        offers: {
          select: { offeredAt: true, outcome: true, decidedAt: true, driver: { select: { id: true, name: true } } },
          orderBy: { offeredAt: "asc" },
        },
        ratings: {
          select: { stars: true, comment: true, createdAt: true, rater: { select: { id: true, name: true, role: true } }, ratee: { select: { id: true, name: true, role: true } } },
        },
        sosEvents: { select: { id: true, createdAt: true, riderId: true, smsDelivered: true, supportNotified: true, handledAt: true } },
        trackingLinks: { select: { createdAt: true, rider: { select: { name: true } } } },
        mergedRides: { select: { id: true, rider: { select: { name: true } } } },
      },
    });
    if (!ride) return reply.code(404).send({ error: "Ride not found" });

    const row = rideRow(ride);
    const timeline: Array<{ at: string; kind: string; text: string }> = [];
    const push = (at: Date | null | undefined, kind: string, text: string) => {
      if (at) timeline.push({ at: at.toISOString(), kind, text });
    };
    push(ride.createdAt, "requested", `${ride.rider.name} asked for a ${ride.type === "SHARED" ? "shared ride" : "ride alone"}`);
    for (const o of ride.offers) {
      const answer =
        o.outcome === "ACCEPTED" ? "accepted" :
        o.outcome === "DECLINED" ? "declined" :
        o.outcome === "TIMED_OUT" ? "let it time out" :
        o.outcome === "TAKEN" ? "missed it (another driver took it)" :
        o.outcome === "CANCELLED" ? "saw it cancelled by the rider" :
        o.outcome === "EXPIRED" ? "saw it expire" : "hasn't answered yet";
      const secs = o.decidedAt ? Math.round((o.decidedAt.getTime() - o.offeredAt.getTime()) / 1000) : null;
      push(o.offeredAt, "offer", `Offered to ${o.driver.name}: ${answer}${secs !== null && (o.outcome === "ACCEPTED" || o.outcome === "DECLINED") ? ` in ${secs} s` : ""}`);
    }
    push(ride.noDriverFoundAt, "no_driver", "No driver took it in time");
    push(ride.matchedAt, "matched", ride.driver ? `${ride.driver.name} took it` : "A driver took it");
    for (const s of ride.passengers) {
      push(s.arrivedAt, "arrived", `Driver arrived for ${s.rider.name}`);
      push(s.noShowAt, "no_show", `${s.rider.name} didn't show`);
    }
    push(ride.departedAt, "started", "Trip started");
    push(ride.completedAt, "completed", "Trip completed");
    if (ride.status === "CANCELLED") {
      const who = cancelledBy(ride);
      const why = ride.riderCancelReason ? RIDER_CANCEL_REASON_LABELS[ride.riderCancelReason] : ride.cancelReason ? SYSTEM_CANCEL_LABELS[ride.cancelReason] : null;
      push(
        ride.cancelledAt ?? ride.createdAt,
        "cancelled",
        ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE"
          ? "Joined another car"
          : `Cancelled by the ${who ?? "rider"}${why ? `: ${why}` : ""}${ride.riderCancelNote ? ` ("${ride.riderCancelNote}")` : ""}`,
      );
    }
    for (const e of ride.sosEvents) push(e.createdAt, "sos", "SOS raised");
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    const pickup = ride.pickupLat != null && ride.pickupLng != null ? { latitude: ride.pickupLat, longitude: ride.pickupLng } : null;
    const dropoff = ride.dropoffLat != null && ride.dropoffLng != null ? { latitude: ride.dropoffLat, longitude: ride.dropoffLng } : null;
    const route = pickup && dropoff ? estimateRoute([pickup, dropoff]) : null;
    const linkUntil = (ride.completedAt ?? ride.cancelledAt)?.getTime();
    const linkActive = linkUntil === undefined || Date.now() - linkUntil < config.trackingLinkTtlHours * 3_600_000;

    return reply.send({
      ride: {
        ...row,
        pickupPin: pickup ? { ...pickup, label: row.pickup, note: ride.pickupNote } : null,
        dropoffPin: dropoff ? { ...dropoff, label: row.dropoff } : null,
        routePolyline: route?.polyline ?? null,
        mergedIntoRideId: ride.mergedIntoRideId,
      },
      timeline,
      offers: ride.offers.map((o) => ({
        driver: o.driver,
        offeredAt: o.offeredAt.toISOString(),
        outcome: o.outcome,
        responseMs: o.decidedAt ? o.decidedAt.getTime() - o.offeredAt.getTime() : null,
      })),
      seats: ride.passengers.map((s) => ({
        id: s.id,
        rider: { id: s.rider.id, name: s.rider.name, maskedPhone: listPhone(s.rider.phone) },
        status: s.status,
        farePesewas: s.status === "CANCELLED" ? null : seatFare(ride.type, s),
        pickup: s.pickupLabel ?? s.pickupZone.name,
        dropoff: s.dropoffLabel ?? s.dropoffZone.name,
        pickupPin: s.pickupLat != null && s.pickupLng != null ? { latitude: s.pickupLat, longitude: s.pickupLng } : null,
        dropoffPin: s.dropoffLat != null && s.dropoffLng != null ? { latitude: s.dropoffLat, longitude: s.dropoffLng } : null,
        joinedAt: s.createdAt.toISOString(),
        arrivedAt: s.arrivedAt?.toISOString() ?? null,
        noShowAt: s.noShowAt?.toISOString() ?? null,
      })),
      ratings: ride.ratings.map((r) => ({ stars: r.stars, comment: r.comment, createdAt: r.createdAt.toISOString(), rater: r.rater, ratee: r.ratee })),
      sos: ride.sosEvents.map((e) => ({ ...e, createdAt: e.createdAt.toISOString(), handledAt: e.handledAt?.toISOString() ?? null })),
      trackingLinks: ride.trackingLinks.map((l) => ({ riderName: l.rider.name, createdAt: l.createdAt.toISOString(), active: linkActive })),
      mergedRides: ride.mergedRides.map((m) => ({ id: m.id, riderName: m.rider.name })),
    });
  });

  /**
   * Supply & demand for a period: requests, how many got a driver and how
   * fast, the no-driver heat grid (weekday × hour), requests against
   * driver-hours online per hour, and the verdict per pickup zone.
   */
  app.get("/admin/supply-demand", { ...gate, schema: SCHEMAS.supply }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`supply:${periodKey(p)}`, async () => {
      const now = new Date();
      const [requests, previous, trips, sessions, zones] = await Promise.all([
        loadRequests(prisma, p),
        prisma.ride.count({ where: { createdAt: { gte: weekEarlier(p).from, lt: weekEarlier(p).to }, isReviewDemo: false } }),
        loadCompletedTrips(prisma, p),
        loadSessions(prisma, p),
        zoneNames(prisma),
      ]);
      const matched = requests.filter(gotDriver);
      const waits = matched.map((r) => gotDriverAt(r)!.getTime() - r.createdAt.getTime()).filter((ms) => ms >= 0);
      const misses = requests.filter(noDriverFound);

      const heatMisses = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
      const heatAll = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
      const hourly = new Array<number>(24).fill(0);
      for (const r of requests) {
        const day = accraWeekday(r.createdAt);
        const hour = accraHour(r.createdAt);
        heatAll[day]![hour]! += 1;
        hourly[hour]! += 1;
        if (noDriverFound(r)) heatMisses[day]![hour]! += 1;
      }
      const onlineMs = onlineMsByHourOfDay(sessions, p, now);

      const verdictInput = {
        requests: requests.map((r) => ({ zoneId: r.pickupZoneId, createdAt: r.createdAt, noDriver: noDriverFound(r) })),
        completedTripTimes: trips.map((t) => t.createdAt),
        onlineMsByHour: onlineMs,
      };
      const verdicts = zoneVerdicts(verdictInput);

      const perZone = new Map<string, typeof requests>();
      for (const r of requests) perZone.set(r.pickupZoneId, [...(perZone.get(r.pickupZoneId) ?? []), r]);
      const zoneRows = [...perZone.entries()]
        .map(([zoneId, rows]) => {
          const got = rows.filter(gotDriver);
          const v = verdicts.get(zoneId);
          return {
            zoneId,
            name: zones.get(zoneId) ?? "Unknown zone",
            requests: rows.length,
            noDriver: rows.filter(noDriverFound).length,
            medianTimeToDriverMs: median(got.map((r) => gotDriverAt(r)!.getTime() - r.createdAt.getTime()).filter((ms) => ms >= 0)),
            need: v?.need ?? 0,
            window: v?.worst?.label ?? null,
            windows: (v?.windows ?? []).map((w) => ({ label: w.label, requests: w.requests, noDriver: w.noDriver, need: w.need })),
          };
        })
        .sort((a, b) => b.requests - a.requests);

      return {
        generatedAt: now.toISOString(),
        requests: requests.length,
        previousRequests: previous,
        gotDriver: matched.length,
        gotDriverRate: ratio(matched.length, requests.length),
        medianTimeToDriverMs: median(waits),
        noDriver: misses.length,
        heat: { noDriver: heatMisses, requests: heatAll },
        hourly: { requests: hourly, driverHours: onlineMs.map((ms) => ms / 3_600_000) },
        zones: zoneRows,
        suggestion: supplySuggestion(verdictInput, verdicts),
      };
    });
    return reply.send(body);
  });

  /**
   * Cancellations in a period: how many, as a share of requests, who
   * cancelled (rider, driver, system), the reasons, before or after a driver
   * took it, by hour, and the cancelled rides (filtered by who).
   */
  app.get("/admin/cancellations", { ...gate, schema: SCHEMAS.cancellations }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const who = (request.query as { who?: (typeof WHO)[number] }).who ?? null;
    const body = await cached(`cancellations:${periodKey(p)}`, async () => {
      const requests = await loadRequests(prisma, p);
      const cancelled = requests.filter((r) => cancelledBy(r) !== null);
      const byWho = { rider: 0, driver: 0, system: 0 };
      const reasons = new Map<string, { reason: string; label: string; count: number }>();
      const byHour = new Array<number>(24).fill(0);
      let afterMatch = 0;
      for (const r of cancelled) {
        byWho[cancelledBy(r)!] += 1;
        byHour[accraHour(r.createdAt)]! += 1;
        if (r.matchedAt || r.driverId) afterMatch += 1;
        const key = r.riderCancelReason ?? r.cancelReason ?? "UNKNOWN";
        const label = r.riderCancelReason
          ? RIDER_CANCEL_REASON_LABELS[r.riderCancelReason as keyof typeof RIDER_CANCEL_REASON_LABELS]
          : SYSTEM_CANCEL_LABELS[r.cancelReason ?? ""] ?? "Not recorded";
        const entry = reasons.get(key) ?? { reason: key, label, count: 0 };
        entry.count += 1;
        reasons.set(key, entry);
      }
      const rows = await prisma.ride.findMany({
        where: { id: { in: cancelled.map((r) => r.id).slice(-500) } },
        select: RIDE_ROW_SELECT,
        orderBy: { createdAt: "desc" },
      });
      return {
        generatedAt: new Date().toISOString(),
        cancellations: cancelled.length,
        requests: requests.length,
        rate: ratio(cancelled.length, requests.length),
        byWho,
        beforeMatch: cancelled.length - afterMatch,
        afterMatch,
        byHour,
        reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
        rides: rows.map(rideRow),
      };
    });
    return reply.send(who ? { ...body, rides: body.rides.filter((r) => r.cancelledBy === who) } : body);
  });

  /**
   * Where rides started and ended in a period (pins on a ~55 m grid, for the
   * Places heat map), and the busiest named places with their no-driver
   * count. Requests booked with exact pins only for the map; labels for the
   * table.
   */
  app.get("/admin/places/activity", { ...gate, schema: SCHEMAS.placesActivity }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const p = periodOr400(request.query, reply);
    if (!p) return;
    const body = await cached(`places:${periodKey(p)}`, async () => {
      const rides = await prisma.ride.findMany({
        where: { createdAt: { gte: p.from, lt: p.to }, isReviewDemo: false },
        select: {
          status: true,
          cancelReason: true,
          matchedAt: true,
          noDriverFoundAt: true,
          pickupLat: true,
          pickupLng: true,
          pickupLabel: true,
          dropoffLat: true,
          dropoffLng: true,
          dropoffLabel: true,
          pickupZone: { select: { name: true } },
          dropoffZone: { select: { name: true } },
        },
      });
      const pickups = new Map<string, { latitude: number; longitude: number; count: number }>();
      const dropoffs = new Map<string, { latitude: number; longitude: number; count: number }>();
      const places = new Map<string, { name: string; pickups: number; dropoffs: number; noDriver: number }>();
      const add = (grid: typeof pickups, lat: number | null, lng: number | null) => {
        if (lat == null || lng == null) return;
        const key = cellOf(lat, lng);
        const cell = grid.get(key) ?? { latitude: Math.round(lat / HEAT_GRID_DEG) * HEAT_GRID_DEG, longitude: Math.round(lng / HEAT_GRID_DEG) * HEAT_GRID_DEG, count: 0 };
        cell.count += 1;
        grid.set(key, cell);
      };
      const place = (name: string) => {
        const entry = places.get(name) ?? { name, pickups: 0, dropoffs: 0, noDriver: 0 };
        places.set(name, entry);
        return entry;
      };
      for (const r of rides) {
        add(pickups, r.pickupLat, r.pickupLng);
        add(dropoffs, r.dropoffLat, r.dropoffLng);
        const from = place(r.pickupLabel ?? r.pickupZone.name);
        from.pickups += 1;
        if (noDriverFound(r)) from.noDriver += 1;
        place(r.dropoffLabel ?? r.dropoffZone.name).dropoffs += 1;
      }
      return {
        generatedAt: new Date().toISOString(),
        pickups: [...pickups.values()],
        dropoffs: [...dropoffs.values()],
        places: [...places.values()].sort((a, b) => b.pickups + b.dropoffs - (a.pickups + a.dropoffs)).slice(0, 25),
      };
    });
    return reply.send(body);
  });
}
