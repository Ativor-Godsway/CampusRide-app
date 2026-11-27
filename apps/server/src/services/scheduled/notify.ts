import type { PrismaClient } from "@prisma/client";
import { SCHEDULE_EVENTS, type PushKind } from "@rida/shared";
import { logger } from "../../lib/logger";
import { emitBoardChanged, emitToDrivers, emitToRiders } from "../../realtime/rideSocket";
import { isPushEnabled, sendPush } from "../push/pushService";
import { liveDriverWhere } from "../zones/driverLiveness";

/**
 * Scheduled rides: pushes (words written here from @rida/shared
 * rides/scheduled.ts, first names only) and socket nudges. Nothing here
 * throws or needs awaiting by a caller that doesn't want to.
 */

/** A push about a scheduled ride. `id` goes in the notification's data (a car, booking or ride id). */
export function schedulePush(
  prisma: PrismaClient,
  push: {
    userIds: readonly string[];
    kind: PushKind;
    id: string;
    title: string;
    body: string;
    /** What this push is about, so the same news isn't sent twice. */
    dedupeKey: string;
    categoryId?: string;
  },
): void {
  if (!isPushEnabled() || push.userIds.length === 0) return;
  void sendPush(prisma, {
    userIds: push.userIds,
    kind: push.kind,
    rideId: push.id,
    text: { schedule: { title: push.title, body: push.body } },
    dedupeKey: push.dedupeKey,
    ...(push.categoryId ? { categoryId: push.categoryId } : {}),
  }).catch((err) => logger.warn("scheduled: push failed", { err, kind: push.kind }));
}

/** These riders' booking changed: their app refetches it. */
export function riderScheduleChanged(riderIds: readonly string[], payload: { carId: string; rideId?: string | null } ): void {
  emitToRiders(riderIds, SCHEDULE_EVENTS.RIDER_CHANGED, payload);
}

/** Approved drivers whose app is live now (the ones a scheduled car is offered to and whose lists refresh). */
export async function liveDriverIds(prisma: PrismaClient): Promise<string[]> {
  const drivers = await prisma.driver.findMany({
    where: { ...liveDriverWhere(), isApproved: true, user: { isReviewDemo: false, deletedAt: null } },
    select: { userId: true },
  });
  return drivers.map((d) => d.userId);
}

/** Every live driver's Schedule tab and board refetch (a car was offered, taken, changed or went). */
export function refreshDriverLists(prisma: PrismaClient, also: readonly string[] = []): void {
  void liveDriverIds(prisma)
    .then((ids) => {
      const all = [...new Set([...ids, ...also])];
      emitToDrivers(all, SCHEDULE_EVENTS.DRIVER_CHANGED, {});
      emitBoardChanged(all);
    })
    .catch((err) => logger.warn("scheduled: driver refresh failed", { err }));
}
