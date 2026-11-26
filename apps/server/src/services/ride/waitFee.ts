import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  CLIENT_FEATURES_HEADER,
  DEFAULT_WAIT_FEE_SETTINGS,
  WAIT_FEE_FEATURE,
  hasClientFeature,
  WAIT_TIMER_RADIUS_METERS,
  haversineDistanceMeters,
  type LatLng,
  type WaitFeeSettings,
} from "@rida/shared";
import { logger } from "../../lib/logger";
import { isPushEnabled, sendPush } from "../push/pushService";

/**
 * The pickup wait fee (2026-11-25) — the rules are in @rida/shared
 * rides/waitFee.ts. Here: the admin setting (kept in memory like the search
 * window), the GPS check that starts a rider's timer, the warning push and
 * the "this rider's app shows the timer" marker that make the fee fair, and
 * the admin's per-day totals.
 *
 * Where it lives on the seat (RidePassenger): waitStartedAt, freeWaitEndsAt,
 * waitFeeAmount, noShowOpensAt (set when the timer starts, from the settings
 * then), riderWarnedAt (the warning reached the rider), waitFee (charged at
 * pickup and included in lockedFare). Done in services/ride/rideService.ts.
 */

const SETTING_ID = "wait";
let current: WaitFeeSettings = { ...DEFAULT_WAIT_FEE_SETTINGS };

/** The settings now (from memory: loaded at start, every minute, and on save). */
export function waitFeeSettings(): WaitFeeSettings {
  return current;
}

export interface StoredWaitFeeSettings extends WaitFeeSettings {
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The stored setting (no row: the defaults), and keeps it in memory. */
export async function readWaitFeeSettings(prisma: PrismaClient): Promise<StoredWaitFeeSettings> {
  const row = await prisma.waitFeeSetting.findUnique({ where: { id: SETTING_ID } });
  current = row
    ? { freeWaitSeconds: row.freeWaitSeconds, feePesewas: row.feePesewas, noShowMinutes: row.noShowMinutes }
    : { ...DEFAULT_WAIT_FEE_SETTINGS };
  return { ...current, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
}

/** Reloads it, never throwing (the minute timer in index.ts). */
export function refreshWaitFeeSettings(prisma: PrismaClient): Promise<void> {
  return readWaitFeeSettings(prisma).then(
    () => undefined,
    (err) => logger.warn("wait fee settings: reload failed", { err }),
  );
}

/** Saves it with an audit row (checked by the caller: waitFeeSettingsProblem). Waits already running keep theirs. */
export async function saveWaitFeeSettings(
  prisma: PrismaClient,
  next: WaitFeeSettings,
  adminId: string,
): Promise<StoredWaitFeeSettings> {
  const before = current;
  const describe = (s: WaitFeeSettings) => `${s.freeWaitSeconds} s free, ${s.feePesewas} pesewas, no-show ${s.noShowMinutes} min`;
  await prisma.$transaction([
    prisma.waitFeeSetting.upsert({
      where: { id: SETTING_ID },
      create: { id: SETTING_ID, ...next, updatedBy: adminId },
      update: { ...next, updatedBy: adminId },
    }),
    prisma.adminAuditLog.create({
      data: { actor: adminId, action: "ride.wait_fee", target: SETTING_ID, reason: `${describe(before)} → ${describe(next)}` },
    }),
  ]);
  return readWaitFeeSettings(prisma);
}

/** Tests only: set the settings without the database. */
export function setWaitFeeSettingsForTests(next: Partial<WaitFeeSettings> = {}): void {
  current = { ...DEFAULT_WAIT_FEE_SETTINGS, ...next };
}

// ─── Starting the timer ─────────────────────────────────────────────────────

/** The wait columns cleared, for a seat put back to WAITING. */
export const CLEARED_WAIT = {
  waitStartedAt: null,
  freeWaitEndsAt: null,
  waitFeeAmount: null,
  riderWarnedAt: null,
  noShowOpensAt: null,
} as const;

/** A position the driver's app sent this long ago still counts as "latest". */
export const WAIT_POSITION_FRESH_MS = 60_000;

export type WaitTimerCheck = "STARTED" | "TOO_FAR" | "NO_POSITION";

/** The words the driver sees when the timer didn't start. */
export const GET_CLOSER_MESSAGE = "Get closer to the pickup to start the wait timer.";

/** Where the rider waits: their exact pin, or their pickup zone's centre for a seat booked without one. */
export function seatPickupPoint(
  seat: { pickupLat: number | null; pickupLng: number | null; pickupZoneId: string },
  zones: ReadonlyMap<string, { latitude: number; longitude: number }>,
): LatLng | null {
  if (seat.pickupLat != null && seat.pickupLng != null) return { latitude: seat.pickupLat, longitude: seat.pickupLng };
  const zone = zones.get(seat.pickupZoneId);
  return zone ? { latitude: zone.latitude, longitude: zone.longitude } : null;
}

/** Whether the driver at `driver` may start the wait at `pickup`. */
export function checkWaitTimer(driver: LatLng | null, pickup: LatLng | null): WaitTimerCheck {
  if (!driver || !pickup) return "NO_POSITION";
  return haversineDistanceMeters(driver, pickup) <= WAIT_TIMER_RADIUS_METERS ? "STARTED" : "TOO_FAR";
}

// ─── Fair warning ───────────────────────────────────────────────────────────

/**
 * The arrival push that states the free wait and the fee. Once Expo accepts
 * it for at least one of the rider's phones, the rider counts as warned
 * (riderWarnedAt) — if that is still before the free wait ends. Never throws.
 */
export function warnRiderOfWait(
  prisma: PrismaClient,
  seat: { id: string; riderId: string; rideId: string; waitStartedAt: Date; freeWaitEndsAt: Date; waitFeeAmount: number },
): Promise<void> {
  if (!isPushEnabled()) return Promise.resolve();
  const seconds = Math.round((seat.freeWaitEndsAt.getTime() - seat.waitStartedAt.getTime()) / 1000);
  return (async () => {
    const accepted = await sendPush(prisma, {
      userIds: [seat.riderId],
      kind: "DRIVER_ARRIVED",
      rideId: seat.rideId,
      // Its own dedupe key: a plain "your driver is here" may have gone moments ago (timer started on a second tap).
      dedupeKey: `DRIVER_ARRIVED:wait:${seat.id}`,
      text: { freeWait: { seconds, feePesewas: seat.waitFeeAmount } },
    });
    if (accepted === 0) return;
    const now = new Date();
    // Only the wait it was sent for, and only in time.
    await prisma.ridePassenger.updateMany({
      where: {
        id: seat.id,
        waitStartedAt: seat.waitStartedAt,
        riderWarnedAt: null,
        freeWaitEndsAt: { gte: now },
      },
      data: { riderWarnedAt: now },
    });
  })().catch((err) => logger.error("wait fee: warning push failed", { err, rideId: seat.rideId }));
}

/** Riders whose app has already been marked (this process), so it's one write per rider. */
const markedApps = new Set<string>();
const MAX_MARKED = 50_000;

/**
 * This rider's app sent the wait-fee feature header: from now on they count
 * as warned at the start of every wait (their app shows the countdown). One
 * write per rider per server start; never throws.
 */
export function markWaitFeeApp(prisma: PrismaClient, userId: string): void {
  if (markedApps.has(userId)) return;
  if (markedApps.size >= MAX_MARKED) markedApps.clear();
  markedApps.add(userId);
  void prisma.user
    .updateMany({ where: { id: userId, waitFeeAppAt: null }, data: { waitFeeAppAt: new Date() } })
    .catch((err) => {
      markedApps.delete(userId);
      logger.warn("wait fee: marking the rider app failed", { err });
    });
}

/**
 * Marks every signed-in rider whose request carries the wait-fee feature
 * header (a preHandler, so after each route's requireAuth). Cheap: one write
 * per rider per server start.
 */
export function installWaitFeeAppMarker(app: FastifyInstance, prisma: PrismaClient): void {
  app.addHook("preHandler", async (request) => {
    if (request.user?.role === "RIDER" && hasClientFeature(request.headers[CLIENT_FEATURES_HEADER], WAIT_FEE_FEATURE)) {
      markWaitFeeApp(prisma, request.user.userId);
    }
  });
}

/** Tests only. */
export function resetWaitFeeAppMarksForTests(): void {
  markedApps.clear();
}

// ─── Admin: per day ─────────────────────────────────────────────────────────

export interface WaitFeeDay {
  day: string;
  /** Wait fees on trips completed that day, in pesewas. */
  feesPesewas: number;
  /** Riders who paid one. */
  lateRiders: number;
  /** "Rider didn't show" cancels (no fee, recorded). */
  noShows: number;
}

/**
 * Wait fees collected per Accra day (seats carried to the end with a fee:
 * dropped off, or a Ride-alone trip completed) and no-shows per day. Review
 * demo rides left out.
 */
export async function waitFeesByDay(
  prisma: PrismaClient,
  period: { from: Date; to: Date },
  dayOf: (d: Date) => string,
  days: readonly string[],
): Promise<{ days: WaitFeeDay[]; totalPesewas: number; lateRiders: number; noShows: number }> {
  const [paid, noShows] = await Promise.all([
    prisma.ridePassenger.findMany({
      where: {
        waitFee: { gt: 0 },
        ride: { isReviewDemo: false },
        OR: [
          { status: "DROPPED_OFF", droppedOffAt: { gte: period.from, lt: period.to } },
          { status: { not: "CANCELLED" }, ride: { status: "COMPLETED", completedAt: { gte: period.from, lt: period.to } } },
        ],
      },
      select: { id: true, waitFee: true, droppedOffAt: true, ride: { select: { completedAt: true } } },
    }),
    prisma.ridePassenger.findMany({
      where: { noShowAt: { gte: period.from, lt: period.to }, ride: { isReviewDemo: false } },
      select: { noShowAt: true },
    }),
  ]);
  const perDay = new Map(days.map((d) => [d, { day: d, feesPesewas: 0, lateRiders: 0, noShows: 0 }]));
  let totalPesewas = 0;
  for (const s of paid) {
    const at = s.droppedOffAt ?? s.ride.completedAt;
    if (!at) continue;
    const day = perDay.get(dayOf(at));
    totalPesewas += s.waitFee ?? 0;
    if (day) {
      day.feesPesewas += s.waitFee ?? 0;
      day.lateRiders += 1;
    }
  }
  for (const s of noShows) {
    const day = s.noShowAt ? perDay.get(dayOf(s.noShowAt)) : undefined;
    if (day) day.noShows += 1;
  }
  return { days: [...perDay.values()], totalPesewas, lateRiders: paid.length, noShows: noShows.length };
}
