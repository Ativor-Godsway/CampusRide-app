import type { PrismaClient } from "@prisma/client";
import { haversineDistanceMeters as haversineMeters } from "@rida/shared";
import { accraDay, accraHour, daysIn, type Period } from "./period";

/**
 * The investor KPIs (admin site, Overview), by the SAME definitions as the
 * week-1 investor report (Claude outputs/launch-analysis/week1/investor-kpis.md,
 * scripts/week1.py), so the site and the report give the same numbers:
 *
 * - Test, staging and review-demo data are left out: accounts whose phone is
 *   a test number (+233099…, +23399…) or whose name ends "(test)" /
 *   "staging", review-demo accounts and rides, rides noted "test ride", and
 *   the production request-board test window (25 Nov 08:05–08:20).
 * - A REQUEST is a ride a rider booked, not a rebook the server made after a
 *   driver cancelled (DriverCancellation.rebookedRideId). Its outcome follows
 *   the rebook chain to the last ride, and a merge into a car to that car,
 *   then the rider's seat there.
 * - COMPLETED: a driver accepted and the rider's seat was dropped off.
 *   "No driver found": never accepted and auto-closed (NO_DRIVERS_AVAILABLE).
 * - Time to accept: request → first driver accept (or the seat being added to
 *   a car). Pickup wait: accept → the driver arriving at the seat.
 * - A CAR TRIP is a ride with a driver, not merged away, with ≥1 seat dropped
 *   off. Riders per car trip = completed requests ÷ car trips.
 * - GMV = the stored fares of the completed requests' seats (wait fees in).
 * - Registered riders = rider accounts created before the period's end
 *   (closed ones too). Days are Accra days (= UTC) of the request.
 */

/** Rides of the production request-board test (2026-11-25), left out like the report does. */
export const EXCLUDED_WINDOWS: ReadonlyArray<{ from: Date; to: Date }> = [
  { from: new Date("2026-11-25T08:05:00.000Z"), to: new Date("2026-11-25T08:20:00.000Z") },
];

/** The day CampusRide launched (Overview "Since launch"). */
export const LAUNCH_DAY = "2026-11-23";

const RETRY_MS = 15 * 60_000;
const NEAREST_PLACE_M = 150;

export interface KpiUser {
  id: string;
  role: string;
  phone: string;
  name: string;
  createdAt: Date;
  isReviewDemo: boolean;
}

export interface KpiRide {
  id: string;
  riderId: string;
  driverId: string | null;
  type: "LONE" | "SHARED";
  status: string;
  booking: string;
  createdAt: Date;
  matchedAt: Date | null;
  cancelReason: string | null;
  noDriverFoundAt: Date | null;
  mergedIntoRideId: string | null;
  isReviewDemo: boolean;
  pickupNote: string | null;
  riderCancelNote: string | null;
  pickupPlaceId: string | null;
  dropoffPlaceId: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  pickupZoneId: string;
  dropoffZoneId: string;
}

export interface KpiSeat {
  id: string;
  rideId: string;
  riderId: string;
  status: string;
  seats: number;
  fareCharged: number | null;
  createdAt: Date;
  arrivedAt: Date | null;
}

export interface KpiDriverCancel {
  rideId: string;
  riderId: string;
  rebookedRideId: string | null;
}

export interface KpiInput {
  users: KpiUser[];
  rides: KpiRide[];
  seats: KpiSeat[];
  driverCancels: KpiDriverCancel[];
  places: Array<{ id: string; name: string; latitude: number; longitude: number }>;
  zones: Map<string, string>;
  /** Rides another ride rebooked to (whatever their date). */
  rebookedIds: Set<string>;
}

/** A test, staging or review-demo account (left out everywhere). */
export function isTestAccount(u: Pick<KpiUser, "phone" | "name" | "isReviewDemo">): boolean {
  const name = u.name.toLowerCase();
  return u.isReviewDemo || u.phone.startsWith("+233099") || u.phone.startsWith("+23399") || name.endsWith("(test)") || name.endsWith("staging") || name.includes("(test)");
}

function isTestRide(r: KpiRide): boolean {
  const note = `${r.pickupNote ?? ""} ${r.riderCancelNote ?? ""}`.toLowerCase();
  return r.isReviewDemo || note.includes("test ride") || EXCLUDED_WINDOWS.some((w) => r.createdAt >= w.from && r.createdAt < w.to);
}

function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

function pct(a: number, b: number): number | null {
  return b ? Math.round((1000 * a) / b) / 10 : null;
}

interface RequestOutcome {
  ride: KpiRide;
  day: string;
  hour: number;
  accepted: boolean;
  completed: boolean;
  noDriver: boolean;
  acceptSeconds: number | null;
  pickupWaitMin: number | null;
  farePesewas: number;
  seats: number;
  retry: boolean;
}

/** Works out every KPI for the period from the loaded rows (pure: tested with plain objects). */
export function computeKpis(input: KpiInput, p: Period, rateBps: number) {
  const testUsers = new Set(input.users.filter(isTestAccount).map((u) => u.id));
  const rides = input.rides.filter((r) => !isTestRide(r) && !testUsers.has(r.riderId));
  const rideBy = new Map(rides.map((r) => [r.id, r]));
  const seats = input.seats.filter((s) => !testUsers.has(s.riderId));
  const seatsByRide = new Map<string, KpiSeat[]>();
  for (const s of seats) seatsByRide.set(s.rideId, [...(seatsByRide.get(s.rideId) ?? []), s]);
  const cancelBy = new Map(input.driverCancels.map((d) => [`${d.rideId}|${d.riderId}`, d]));

  const seatOf = (rideId: string, riderId: string): KpiSeat | null => {
    const mine = (seatsByRide.get(rideId) ?? []).filter((s) => s.riderId === riderId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return mine[mine.length - 1] ?? null;
  };

  const inPeriod = (d: Date) => d >= p.from && d < p.to;
  const requests = rides
    .filter((r) => inPeriod(r.createdAt) && !input.rebookedIds.has(r.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const lastByRider = new Map<string, Date>();
  const outcomes: RequestOutcome[] = requests.map((r) => {
    const chain = [r];
    const seen = new Set<string>();
    let cur = r;
    for (;;) {
      const dc = cancelBy.get(`${cur.id}|${r.riderId}`);
      if (!dc || seen.has(cur.id)) break;
      seen.add(cur.id);
      const next = dc.rebookedRideId ? rideBy.get(dc.rebookedRideId) : undefined;
      if (!next) break;
      chain.push(next);
      cur = next;
    }
    const merged = cur.cancelReason === "MERGED_INTO_ANOTHER_RIDE" && cur.mergedIntoRideId !== null && rideBy.has(cur.mergedIntoRideId);
    const car = merged ? rideBy.get(cur.mergedIntoRideId!)! : cur;
    const seat = seatOf(car.id, r.riderId);
    const matched = chain.map((c) => c.matchedAt).filter((d): d is Date => d !== null);
    let acceptAt: Date | null = matched.length ? new Date(Math.min(...matched.map((d) => d.getTime()))) : null;
    if (merged && seat && !acceptAt) acceptAt = seat.createdAt;
    const accepted = acceptAt !== null;
    const completed = accepted && seat !== null && seat.status === "DROPPED_OFF";
    const prev = lastByRider.get(r.riderId);
    lastByRider.set(r.riderId, r.createdAt);
    return {
      ride: r,
      day: accraDay(r.createdAt),
      hour: accraHour(r.createdAt),
      accepted,
      completed,
      noDriver: !accepted && cur.cancelReason === "NO_DRIVERS_AVAILABLE",
      acceptSeconds: acceptAt ? (acceptAt.getTime() - r.createdAt.getTime()) / 1000 : null,
      pickupWaitMin: accepted && seat?.arrivedAt && acceptAt ? (seat.arrivedAt.getTime() - acceptAt.getTime()) / 60_000 : null,
      farePesewas: completed ? (seat!.fareCharged ?? 0) : 0,
      seats: completed ? seat!.seats : 0,
      retry: prev !== undefined && r.createdAt.getTime() - prev.getTime() <= RETRY_MS,
    };
  });

  // Car trips: a driver, not merged away, at least one seat dropped off; on the day it was created.
  const cars = rides.filter(
    (c) => c.driverId && c.cancelReason !== "MERGED_INTO_ANOTHER_RIDE" && inPeriod(c.createdAt) && (seatsByRide.get(c.id) ?? []).some((s) => s.status === "DROPPED_OFF"),
  );

  const riders = input.users.filter((u) => u.role === "RIDER" && !testUsers.has(u.id) && u.createdAt < p.to);
  const signups = riders.filter((u) => u.createdAt >= p.from);
  const done = outcomes.filter((o) => o.completed);

  const perRider = new Map<string, { requests: number; completed: number; days: Set<string>; firstDay: string; firstDoneDay: string | null }>();
  for (const o of outcomes) {
    const e = perRider.get(o.ride.riderId) ?? { requests: 0, completed: 0, days: new Set<string>(), firstDay: o.day, firstDoneDay: null };
    e.requests += 1;
    e.days.add(o.day);
    if (o.completed) {
      e.completed += 1;
      if (!e.firstDoneDay || o.day < e.firstDoneDay) e.firstDoneDay = o.day;
    }
    perRider.set(o.ride.riderId, e);
  }
  const requested = [...perRider.values()];
  const served = requested.filter((e) => e.completed >= 1);
  const repeat = served.filter((e) => e.completed >= 2);
  const days = daysIn(p);
  const lastDay = days[days.length - 1];
  // Came back: first completed ride before the period's last day, then requested again on a later day.
  const cameBackBase = served.filter((e) => e.firstDoneDay! < lastDay!);
  const cameBack = cameBackBase.filter((e) => [...e.days].some((d) => d > e.firstDoneDay!));
  const neverBase = requested.filter((e) => e.completed === 0 && e.firstDay < lastDay!);
  const neverBack = neverBase.filter((e) => [...e.days].some((d) => d > e.firstDay));

  const gmv = done.reduce((s, o) => s + o.farePesewas, 0);
  const attempts = outcomes.filter((o) => !o.retry).length;
  const registered = riders.length;

  const daily = days.map((day) => {
    const os = outcomes.filter((o) => o.day === day);
    const c = os.filter((o) => o.completed);
    return {
      day,
      signups: signups.filter((u) => accraDay(u.createdAt) === day).length,
      requests: os.length,
      completed: c.length,
      completionPct: pct(c.length, os.length),
      noDriver: os.filter((o) => o.noDriver).length,
      gmvPesewas: c.reduce((s, o) => s + o.farePesewas, 0),
      carTrips: cars.filter((x) => accraDay(x.createdAt) === day).length,
      ridersRequesting: new Set(os.map((o) => o.ride.riderId)).size,
    };
  });

  const byHour = Array.from({ length: 24 }, (_, hour) => {
    const os = outcomes.filter((o) => o.hour === hour);
    return { hour, requests: os.length, completed: os.filter((o) => o.completed).length };
  });

  const placeName = new Map(input.places.map((pl) => [pl.id, pl.name]));
  const nearest = (lat: number | null, lng: number | null): string | null => {
    if (lat === null || lng === null) return null;
    let best: { name: string; d: number } | null = null;
    for (const pl of input.places) {
      const d = haversineMeters({ latitude: lat, longitude: lng }, { latitude: pl.latitude, longitude: pl.longitude });
      if (!best || d < best.d) best = { name: pl.name, d };
    }
    return best && best.d <= NEAREST_PLACE_M ? best.name : null;
  };
  const top = (pick: (o: RequestOutcome) => string) => {
    const m = new Map<string, { name: string; requests: number; completed: number }>();
    for (const o of outcomes) {
      const name = pick(o);
      const e = m.get(name) ?? { name, requests: 0, completed: 0 };
      e.requests += 1;
      if (o.completed) e.completed += 1;
      m.set(name, e);
    }
    return [...m.values()].sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)).slice(0, 10);
  };
  const zoneLabel = (id: string) => `(near ${input.zones.get(id) ?? "?"} zone)`;
  const topPickups = top((o) => (o.ride.pickupPlaceId && placeName.get(o.ride.pickupPlaceId)) || nearest(o.ride.pickupLat, o.ride.pickupLng) || zoneLabel(o.ride.pickupZoneId));
  const topDropoffs = top((o) => (o.ride.dropoffPlaceId && placeName.get(o.ride.dropoffPlaceId)) || nearest(o.ride.dropoffLat, o.ride.dropoffLng) || zoneLabel(o.ride.dropoffZoneId));

  const funnelSteps: Array<[string, number]> = [
    ["Registered", registered],
    ["Requested a ride", requested.length],
    ["Got a ride", served.length],
    ["2+ rides", repeat.length],
  ];

  return {
    period: { from: p.from.toISOString(), to: p.to.toISOString() },
    kpis: {
      registeredRiders: registered,
      newSignups: signups.length,
      ridersRequested: requested.length,
      ridersServed: served.length,
      repeatRiders: repeat.length,
      repeatPct: pct(repeat.length, served.length),
      requests: outcomes.length,
      tripAttempts: attempts,
      completedRides: done.length,
      seatsCarried: done.reduce((s, o) => s + o.seats, 0),
      completionPct: pct(done.length, outcomes.length),
      completionPctOfAttempts: pct(done.length, attempts),
      acceptedPct: pct(outcomes.filter((o) => o.accepted).length, outcomes.length),
      noDriverPct: pct(outcomes.filter((o) => o.noDriver).length, outcomes.length),
      gmvPesewas: gmv,
      avgFarePesewas: done.length ? Math.round(gmv / done.length) : null,
      carTrips: cars.length,
      ridersPerCarTrip: cars.length ? Math.round((100 * done.length) / cars.length) / 100 : null,
      activeDrivers: new Set(cars.map((c) => c.driverId)).size,
      medianAcceptSeconds: median(outcomes.map((o) => o.acceptSeconds ?? NaN)),
      medianPickupWaitMin: median(outcomes.map((o) => o.pickupWaitMin ?? NaN)),
      commissionAtRatePesewas: Math.round((gmv * rateBps) / 10_000),
      rateBps,
    },
    daily,
    byHour,
    topPickups,
    topDropoffs,
    funnel: funnelSteps.map(([step, n], i) => ({
      step,
      riders: n,
      pctOfRegistered: pct(n, registered),
      pctOfPrevious: i === 0 ? 100 : pct(n, funnelSteps[i - 1]![1]),
    })),
    retention: {
      served: served.length,
      repeat: repeat.length,
      repeatPct: pct(repeat.length, served.length),
      cameBackBase: cameBackBase.length,
      cameBack: cameBack.length,
      cameBackPct: pct(cameBack.length, cameBackBase.length),
      neverServedBase: neverBase.length,
      neverServedCameBack: neverBack.length,
      neverServedCameBackPct: pct(neverBack.length, neverBase.length),
    },
  };
}

export type Kpis = ReturnType<typeof computeKpis>;

const DAY_MS = 86_400_000;

/** Loads what computeKpis needs for the period (a handful of queries) and works it out. */
export async function loadKpis(prisma: PrismaClient, p: Period, rateBps: number): Promise<Kpis> {
  // A rebook or the car a request was merged into can sit just outside the period.
  const window = { gte: new Date(p.from.getTime() - DAY_MS), lt: new Date(p.to.getTime() + DAY_MS) };
  const rideSelect = {
    id: true,
    riderId: true,
    driverId: true,
    type: true,
    status: true,
    booking: true,
    createdAt: true,
    matchedAt: true,
    cancelReason: true,
    noDriverFoundAt: true,
    mergedIntoRideId: true,
    isReviewDemo: true,
    pickupNote: true,
    riderCancelNote: true,
    pickupPlaceId: true,
    dropoffPlaceId: true,
    pickupLat: true,
    pickupLng: true,
    dropoffLat: true,
    dropoffLng: true,
    pickupZoneId: true,
    dropoffZoneId: true,
  } as const;
  const [users, rides, places, zones] = await Promise.all([
    prisma.user.findMany({ where: { role: { in: ["RIDER", "DRIVER"] } }, select: { id: true, role: true, phone: true, name: true, createdAt: true, isReviewDemo: true } }),
    prisma.ride.findMany({ where: { createdAt: window }, select: rideSelect }),
    prisma.place.findMany({ select: { id: true, name: true, latitude: true, longitude: true } }),
    prisma.zone.findMany({ select: { id: true, name: true } }),
  ]);
  const have = new Set(rides.map((r) => r.id));
  const missing = [...new Set(rides.map((r) => r.mergedIntoRideId).filter((x): x is string => x !== null && !have.has(x)))];
  if (missing.length) rides.push(...(await prisma.ride.findMany({ where: { id: { in: missing } }, select: rideSelect })));
  const ids = rides.map((r) => r.id);
  const [seats, driverCancels] = await Promise.all([
    prisma.ridePassenger.findMany({
      where: { rideId: { in: ids } },
      select: { id: true, rideId: true, riderId: true, status: true, seats: true, fareCharged: true, createdAt: true, arrivedAt: true },
    }),
    prisma.driverCancellation.findMany({ where: { OR: [{ rideId: { in: ids } }, { rebookedRideId: { in: ids } }] }, select: { rideId: true, riderId: true, rebookedRideId: true } }),
  ]);
  return computeKpis(
    {
      users,
      rides: rides as KpiRide[],
      seats,
      driverCancels,
      places,
      zones: new Map(zones.map((z) => [z.id, z.name])),
      rebookedIds: new Set(driverCancels.map((d) => d.rebookedRideId).filter((x): x is string => x !== null)),
    },
    p,
    rateBps,
  );
}
