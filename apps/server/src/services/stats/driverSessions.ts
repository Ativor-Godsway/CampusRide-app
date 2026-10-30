import type { DriverSessionEnd, PrismaClient } from "@prisma/client";
import { logger } from "../../lib/logger";

/**
 * Driver online sessions, for the admin dashboard's hours online per driver
 * per day. Recorded beside the real switch (Driver.isOnline), never instead
 * of it: nothing here changes who gets ride requests.
 *
 * - Going online opens a session (if none is open); going offline closes it
 *   (OFFLINE). An admin taking approval away closes it (ADMIN); closing the
 *   account, ACCOUNT_CLOSED.
 * - Its app's positions (services/stats/locationTrail.ts, about once a
 *   minute) keep `lastSeenAt` current. Nothing heard for TIMEOUT_MS: the
 *   session ends at `lastSeenAt` (TIMEOUT) — the app was closed, the phone
 *   off or without signal — even though the driver is still "online" for
 *   dispatch. If the app is heard again while still online, a new session
 *   opens.
 * - A session never heard from (an app that sends no position while idle)
 *   is never timed out: it ends when the driver goes offline.
 *
 * Every write here is one statement and never fails the caller.
 */

/** Nothing heard from a driver's app for this long ends their session. */
export const SESSION_TIMEOUT_MS = 5 * 60_000;
/** After the server starts, no session is timed out for this long: apps are reconnecting. */
const BOOT_GRACE_MS = 5 * 60_000;
const bootedAt = Date.now();

function quietly(what: string, work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    (err) => logger.warn(`driver sessions: ${what} failed`, { err }),
  );
}

/** The driver went online: open a session unless one is open. */
export function openDriverSession(prisma: PrismaClient, driverUserId: string, now: Date = new Date()): Promise<void> {
  return quietly(
    "open",
    (async () => {
      const open = await prisma.driverOnlineSession.findFirst({
        where: { driverUserId, endedAt: null },
        select: { id: true },
      });
      if (!open) await prisma.driverOnlineSession.create({ data: { driverUserId, startedAt: now } });
    })(),
  );
}

/** The driver's open session ends now, for this reason (none open: nothing). */
export function closeDriverSession(
  prisma: PrismaClient,
  driverUserId: string,
  reason: DriverSessionEnd,
  now: Date = new Date(),
): Promise<void> {
  return quietly(
    "close",
    prisma.driverOnlineSession.updateMany({
      where: { driverUserId, endedAt: null },
      data: { endedAt: now, endReason: reason },
    }),
  );
}

/**
 * These drivers' apps were heard from (a batch of positions): their open
 * sessions are seen at the batch's latest time (so `lastSeenAt` is right to
 * within one batch, about a minute), and a driver still online with none
 * open (back after a timeout) gets a new one. At most three statements per
 * batch, whatever its size.
 */
export async function noteDriversHeard(
  prisma: PrismaClient,
  heard: ReadonlyMap<string, Date>,
): Promise<void> {
  if (heard.size === 0) return;
  const ids = [...heard.keys()];
  const latest = new Date(Math.max(...[...heard.values()].map((d) => d.getTime())));
  await prisma.driverOnlineSession.updateMany({
    where: { driverUserId: { in: ids }, endedAt: null },
    data: { lastSeenAt: latest },
  });
  const back = await prisma.driver.findMany({
    where: { userId: { in: ids }, isOnline: true, user: { driverOnlineSessions: { none: { endedAt: null } } } },
    select: { userId: true },
  });
  if (back.length > 0) {
    await prisma.driverOnlineSession.createMany({
      data: back.map((d) => ({ driverUserId: d.userId, startedAt: heard.get(d.userId)!, lastSeenAt: heard.get(d.userId)! })),
    });
  }
}

/**
 * Ends sessions whose app hasn't been heard from for SESSION_TIMEOUT_MS, at
 * the moment it last was (TIMEOUT). Run on a timer (index.ts). Returns how many.
 */
export async function timeOutQuietSessions(
  prisma: PrismaClient,
  now: Date = new Date(),
  serverStartedAt: number = bootedAt,
): Promise<number> {
  if (now.getTime() - serverStartedAt < BOOT_GRACE_MS) return 0;
  const quiet = await prisma.driverOnlineSession.findMany({
    where: { endedAt: null, lastSeenAt: { lt: new Date(now.getTime() - SESSION_TIMEOUT_MS) } },
    select: { id: true, lastSeenAt: true },
    take: 500,
  });
  for (const s of quiet) {
    await prisma.driverOnlineSession.updateMany({
      where: { id: s.id, endedAt: null },
      data: { endedAt: s.lastSeenAt, endReason: "TIMEOUT" },
    });
  }
  return quiet.length;
}
