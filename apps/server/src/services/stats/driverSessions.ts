import type { DriverSessionEnd, PrismaClient } from "@prisma/client";
import { logger } from "../../lib/logger";

/**
 * Driver online sessions, for the admin dashboard's hours online per driver
 * per day: they follow the real switch (Driver.isOnline).
 *
 * - Going online opens a session (if none is open); going offline closes it
 *   (OFFLINE). An admin taking approval away closes it (ADMIN); closing the
 *   account, ACCOUNT_CLOSED.
 * - TIMEOUT: the server took the driver offline after losing touch with the
 *   phone (services/zones/driverPresence.ts, which also ends the session, at
 *   the last contact). Silence alone never ends a session: an Android app in
 *   the background may send no position for a long time and still be online.
 * - Its app's positions (services/stats/locationTrail.ts, about once a
 *   minute) keep `lastSeenAt` current.
 *
 * Every write here is one statement and never fails the caller.
 */

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
 * within one batch, about a minute), and a driver online with none open (one
 * who went online before these records began) gets one. At most three
 * statements per batch, whatever its size.
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
