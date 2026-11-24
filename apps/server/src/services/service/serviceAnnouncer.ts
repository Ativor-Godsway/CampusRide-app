import type { PrismaClient } from "@prisma/client";
import type { ServiceStatus } from "@rida/shared";
import { logger } from "../../lib/logger";
import { emitServiceStatus } from "../../realtime/rideSocket";
import { isPushEnabled } from "../push/pushService";
import { sendOpeningPush } from "../push/broadcast";
import { claimOpeningWaiters, serviceStatus } from "./serviceHours";

/**
 * Keeps the apps up to date with service hours, and keeps the "Notify me"
 * promise. Run every SERVICE_TICK_MS (index.ts), and straight after an admin
 * change or a driver going online/offline:
 *
 * - When the state in force differs from what this server last announced
 *   (opening/closing time passed, Close now, last driver went offline, …),
 *   it goes to every connected app over the socket (serviceStatus payload).
 * - When riders can book, everyone on the "Notify me when you open" list is
 *   taken off it and gets one "We're open!" push (services/push/broadcast.ts).
 *
 * Never throws.
 */

export const SERVICE_TICK_MS = 15_000;

let lastAnnounced: string | null = null;

/** What changes the apps' view; serverTime alone changes nothing. */
function keyOf(status: ServiceStatus): string {
  const { serverTime: _serverTime, ...rest } = status;
  return JSON.stringify(rest);
}

export async function serviceTick(prisma: PrismaClient, now = new Date()): Promise<void> {
  try {
    const status = await serviceStatus(prisma, now);
    const key = keyOf(status);
    if (key !== lastAnnounced) {
      // The first check after a start announces too: harmless, apps merge it.
      lastAnnounced = key;
      emitServiceStatus(status);
    }
    if (status.open && isPushEnabled()) {
      const riders = await claimOpeningWaiters(prisma);
      if (riders.length > 0) await sendOpeningPush(prisma, riders);
    }
  } catch (err) {
    logger.error("service hours: tick failed", { err });
  }
}

/** Checks started by announceServiceSoon and not yet finished (tests wait for them). */
const inFlight = new Set<Promise<void>>();

/** Fire-and-forget form, for routes (an admin change, a driver going online or offline). */
export function announceServiceSoon(prisma: PrismaClient): void {
  const running = serviceTick(prisma);
  inFlight.add(running);
  void running.finally(() => inFlight.delete(running));
}

export async function settleServiceAnnouncementsForTests(): Promise<void> {
  await Promise.all([...inFlight]);
}

export function resetServiceAnnouncerForTests(): void {
  lastAnnounced = null;
}
