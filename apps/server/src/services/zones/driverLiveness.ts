import type { Prisma, PrismaClient } from "@prisma/client";
import { DRIVER_STALE_AFTER_MS } from "@rida/shared";
import { logger } from "../../lib/logger";
import { sendPush } from "../push/pushService";
import { ACTIVE_DRIVER_STATUSES } from "../ride/stateMachine";

/**
 * Whether an online driver is really there (2026-11-24, @rida/shared
 * driver/liveness): online counts only if the app was heard from in the
 * last DRIVER_STALE_AFTER_MS (10 min).
 *
 * "Heard from" is anything the app sends — a position (trip or idle), its
 * presence (in front / in the background), a socket (re)connect, going
 * online — and the live connection's heartbeat: socket.io pings every
 * connected app about every 25 s and the app answers whether or not the car
 * moves, including Android in the background (an answer to a message, not a
 * JS timer). So every driver app already shipped keeps itself live while it
 * runs, with no app update.
 *
 * Kept in Driver.lastHeartbeatAt (so a restart forgets nothing), written at
 * most once a minute per driver from this server's memory — a handful of
 * small writes a minute for the whole fleet.
 */

/** At most one lastHeartbeatAt write per driver this often. */
export const HEARTBEAT_WRITE_EVERY_MS = 60_000;

const lastWritten = new Map<string, number>();

/** The driver's app was heard from: recorded (at most once a minute). Never throws. */
export function noteDriverHeartbeat(prisma: PrismaClient, userId: string, now: number = Date.now()): void {
  const last = lastWritten.get(userId);
  if (last !== undefined && now - last < HEARTBEAT_WRITE_EVERY_MS) return;
  lastWritten.set(userId, now);
  prisma.driver
    .updateMany({ where: { userId }, data: { lastHeartbeatAt: new Date(now) } })
    .catch((err) => {
      lastWritten.delete(userId);
      logger.warn("driver heartbeat write failed", { userId, err });
    });
}

/** The oldest heartbeat that still counts at `now`. */
export function liveSince(now: number = Date.now()): Date {
  return new Date(now - DRIVER_STALE_AFTER_MS);
}

/**
 * Prisma filter for drivers who are online AND live: everything that offers
 * a ride, counts drivers for booking, or shows "online" in admin uses it.
 */
export function liveDriverWhere(now: number = Date.now()): Prisma.DriverWhereInput {
  return { isOnline: true, lastHeartbeatAt: { gte: liveSince(now) } };
}

/** Whether to wait before the first sweep after a start (live apps reconnect within seconds). */
export const SWEEP_GRACE_AFTER_START_MS = 2 * 60_000;

/**
 * Sets offline every online driver not heard from for DRIVER_STALE_AFTER_MS
 * (or never, since this began): out of dispatch (isOnline false, no zone),
 * their open online session ended at their last contact (TIMEOUT), the time
 * kept in autoOfflineAt so their app can say why, and a push notification.
 * A driver with a trip under way is left alone (checked again next time);
 * they get no new requests meanwhile anyway (liveDriverWhere). App Store /
 * Google Play review demo drivers are never touched. Run every minute
 * (index.ts). Returns who was set offline.
 */
export async function takeStaleDriversOffline(prisma: PrismaClient, now: Date = new Date()): Promise<string[]> {
  const cutoff = liveSince(now.getTime());
  const staleWhere: Prisma.DriverWhereInput = {
    isOnline: true,
    OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: cutoff } }],
  };
  const stale = await prisma.driver.findMany({
    where: { ...staleWhere, user: { isReviewDemo: false } },
    select: { userId: true, lastHeartbeatAt: true },
  });
  if (stale.length === 0) return [];
  const onTrip = new Set(
    (
      await prisma.ride.findMany({
        where: { driverId: { in: stale.map((s) => s.userId) }, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
        select: { driverId: true },
      })
    ).map((r) => r.driverId),
  );

  const taken: string[] = [];
  for (const { userId, lastHeartbeatAt } of stale) {
    if (onTrip.has(userId)) continue;
    // Only while still online and still silent: going online again, or a
    // heartbeat landing meanwhile, wins.
    const { count } = await prisma.driver.updateMany({
      where: { userId, ...staleWhere },
      data: { isOnline: false, currentZoneId: null, autoOfflineAt: now },
    });
    if (count === 0) continue;
    lastWritten.delete(userId);
    await endSessionsAtLastContact(prisma, userId, lastHeartbeatAt, now);
    taken.push(userId);
    logger.info("driver set offline: app not heard from", {
      userId,
      silentMinutes: lastHeartbeatAt ? Math.round((now.getTime() - lastHeartbeatAt.getTime()) / 60_000) : null,
    });
    void sendPush(prisma, { userIds: [userId], kind: "WENT_OFFLINE", rideId: "offline" });
  }
  return taken;
}

/**
 * Ends the driver's open online sessions (TIMEOUT) at the last time anything
 * was heard: their heartbeat, else the session's own last sighting, never
 * before it started nor after now.
 */
async function endSessionsAtLastContact(prisma: PrismaClient, userId: string, heardAt: Date | null, now: Date): Promise<void> {
  const open = await prisma.driverOnlineSession.findMany({
    where: { driverUserId: userId, endedAt: null },
    select: { id: true, startedAt: true, lastSeenAt: true },
  });
  for (const s of open) {
    const last = heardAt ?? s.lastSeenAt ?? s.startedAt;
    const endedAt = new Date(Math.min(now.getTime(), Math.max(s.startedAt.getTime(), last.getTime())));
    await prisma.driverOnlineSession.update({ where: { id: s.id }, data: { endedAt, endReason: "TIMEOUT" } });
  }
}

/**
 * When the server set this driver offline for silence, if it did and they
 * haven't gone online since — the answer to their app's PRESENCE, so the app
 * shows them offline and says why.
 */
export async function autoOfflineAt(prisma: PrismaClient, userId: string): Promise<Date | null> {
  const driver = await prisma.driver.findUnique({ where: { userId }, select: { isOnline: true, autoOfflineAt: true } });
  return driver && !driver.isOnline ? driver.autoOfflineAt : null;
}

/** Tests only. */
export function resetDriverLivenessForTests(): void {
  lastWritten.clear();
}
