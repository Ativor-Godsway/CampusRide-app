import type { PrismaClient } from "@prisma/client";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { sendPush } from "../push/pushService";
import { ACTIVE_DRIVER_STATUSES } from "../ride/stateMachine";

/**
 * Whether the server is still in touch with an online driver's phone, and
 * taking a driver offline when it clearly isn't (config.driverSilenceTimeoutMinutes,
 * default 30).
 *
 * What the server can trust (checked on phones' behaviour, 2026-10-31):
 * - a connected socket: the app is running (Android keeps it with the
 *   "You're online" service; iPhone while background location runs);
 * - the app saying where it is (DRIVER_CLIENT_EVENTS.PRESENCE) on every
 *   (re)connect and app state change.
 * Positions alone can't be trusted: an Android app in the background or with
 * the screen locked may send none for a long time.
 *
 * The rule: a driver is silent only when their app last said "foreground",
 * no socket of theirs is connected, and nothing has been heard for the
 * timeout — the phone died, lost signal or the app crashed while in front.
 * A driver whose app said "background" is never taken offline, nor one whose
 * app never said anything (an app from before this), nor one mid-trip.
 *
 * In this server's memory (one instance). After a restart nobody is known
 * until their app reconnects, so nobody is taken offline by mistake.
 */

interface Presence {
  /** The app has sent PRESENCE (an app from before it never does). */
  announced: boolean;
  state: "foreground" | "background";
  sockets: number;
  /** The last contact of any kind (epoch ms). */
  heardAt: number;
}

const presence = new Map<string, Presence>();

function entry(userId: string, now: number): Presence {
  let p = presence.get(userId);
  if (!p) {
    p = { announced: false, state: "foreground", sockets: 0, heardAt: now };
    presence.set(userId, p);
  }
  return p;
}

export function driverSocketConnected(userId: string, now: number = Date.now()): void {
  const p = entry(userId, now);
  p.sockets += 1;
  p.heardAt = now;
}

export function driverSocketDisconnected(userId: string, now: number = Date.now()): void {
  const p = presence.get(userId);
  if (!p) return;
  p.sockets = Math.max(0, p.sockets - 1);
  p.heardAt = now;
}

export function driverSaidPresence(userId: string, state: Presence["state"], now: number = Date.now()): void {
  const p = entry(userId, now);
  p.announced = true;
  p.state = state;
  p.heardAt = now;
}

/** Any other contact (a position). */
export function driverHeard(userId: string, now: number = Date.now()): void {
  const p = presence.get(userId);
  if (p) p.heardAt = now;
}

/** What the server knows of a driver's app now (admin live map), or null when nothing. */
export function driverPresenceOf(
  userId: string,
): { connected: boolean; state: Presence["state"] | null; heardAt: number } | null {
  const p = presence.get(userId);
  if (!p) return null;
  return { connected: p.sockets > 0, state: p.announced ? p.state : null, heardAt: p.heardAt };
}

/** The drivers the rule calls silent now, with when they were last heard. */
export function silentDrivers(now: number = Date.now()): Array<{ userId: string; heardAt: number }> {
  const timeout = config.driverSilenceTimeoutMinutes * 60_000;
  const out: Array<{ userId: string; heardAt: number }> = [];
  for (const [userId, p] of presence) {
    if (p.announced && p.state === "foreground" && p.sockets === 0 && now - p.heardAt >= timeout) {
      out.push({ userId, heardAt: p.heardAt });
    }
  }
  return out;
}

/**
 * Whether this driver was taken offline for silence and hasn't gone online
 * since — the answer to their app's PRESENCE, so it shows them offline.
 */
export async function wasTakenOffline(prisma: PrismaClient, userId: string): Promise<boolean> {
  const [driver, last] = await Promise.all([
    prisma.driver.findUnique({ where: { userId }, select: { isOnline: true } }),
    prisma.driverOnlineSession.findFirst({
      where: { driverUserId: userId },
      orderBy: { startedAt: "desc" },
      select: { endReason: true },
    }),
  ]);
  return driver?.isOnline === false && last?.endReason === "TIMEOUT";
}

/**
 * Takes every silent driver offline: out of dispatch (isOnline false, no
 * zone), their online session ended at the last contact (TIMEOUT), and a
 * push notification. A driver mid-trip is left alone (and checked again
 * next time). Run every minute (index.ts). Returns who was taken offline.
 */
export async function takeSilentDriversOffline(prisma: PrismaClient, now: Date = new Date()): Promise<string[]> {
  const silent = silentDrivers(now.getTime());
  if (silent.length === 0) return [];
  const onTrip = new Set(
    (
      await prisma.ride.findMany({
        where: { driverId: { in: silent.map((s) => s.userId) }, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
        select: { driverId: true },
      })
    ).map((r) => r.driverId),
  );
  const taken: string[] = [];
  for (const { userId, heardAt } of silent) {
    if (onTrip.has(userId)) continue;
    // Only a driver still online; a concurrent "go online/offline" wins.
    const { count } = await prisma.driver.updateMany({
      where: { userId, isOnline: true },
      data: { isOnline: false, currentZoneId: null },
    });
    presence.delete(userId);
    if (count === 0) continue;
    await prisma.driverOnlineSession.updateMany({
      where: { driverUserId: userId, endedAt: null },
      data: { endedAt: new Date(heardAt), endReason: "TIMEOUT" },
    });
    taken.push(userId);
    logger.info("driver taken offline: phone out of touch", { userId, silentMinutes: Math.round((now.getTime() - heardAt) / 60_000) });
    void sendPush(prisma, { userIds: [userId], kind: "WENT_OFFLINE", rideId: "offline" });
  }
  return taken;
}

/** Forgets drivers with no socket who haven't been heard from in a day (memory stays flat). */
export function sweepDriverPresence(now: number = Date.now()): void {
  for (const [userId, p] of presence) {
    if (p.sockets === 0 && now - p.heardAt > 24 * 60 * 60_000) presence.delete(userId);
  }
}

/** Tests only. */
export function resetDriverPresenceForTests(): void {
  presence.clear();
}
