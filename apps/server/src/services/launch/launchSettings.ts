import type { PrismaClient } from "@prisma/client";
import {
  LAUNCH_NOT_OPEN_CODE,
  effectiveLaunchMode,
  isLaunchExempt,
  launchClockTime,
  launchDay,
  launchNotOpenMessage,
  type LaunchMode,
  type LaunchStatus,
} from "@rida/shared";

/**
 * Launch mode on the server (@rida/shared launch/launchMode.ts has the
 * rules): the one LaunchSetting row, the gate every ride booking passes
 * (createRide), and the admin site's changes — each written to
 * AdminAuditLog in the same transaction as the change.
 *
 * The countdown becomes LIVE at `launchAt` by itself: nothing rewrites the
 * row, every read compares launchAt with the clock (effectiveLaunchMode).
 */

const ROW_ID = "launch";

/**
 * The row is read at most every 10 s per server: the apps ask for the status
 * every minute or so, and each booking checks it. A change made here clears
 * it at once; another server instance sees it within the 10 s. The launch
 * moment itself is never late — it is compared with the clock on every read.
 */
const CACHE_MS = 10_000;

export interface StoredLaunch {
  mode: LaunchMode;
  launchAt: Date | null;
  updatedAt: Date | null;
  /** User.id of the admin who last changed it. */
  updatedBy: string | null;
  /** Send "CampusRide is live!" when the mode in force turns LIVE (services/push/broadcast.ts). */
  launchPushEnabled: boolean;
}

const NEVER_SET: StoredLaunch = {
  mode: "OFF",
  launchAt: null,
  updatedAt: null,
  updatedBy: null,
  launchPushEnabled: false,
};

function stored(row: {
  mode: LaunchMode;
  launchAt: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
  launchPushEnabled: boolean;
}): StoredLaunch {
  return {
    mode: row.mode,
    launchAt: row.launchAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    launchPushEnabled: row.launchPushEnabled,
  };
}

let cached: { value: StoredLaunch; readAt: number } | null = null;

export function clearLaunchCache(): void {
  cached = null;
}

/** The stored setting (no row: OFF). */
export async function readLaunchSetting(prisma: PrismaClient): Promise<StoredLaunch> {
  if (cached && Date.now() - cached.readAt < CACHE_MS) return cached.value;
  const row = await prisma.launchSetting.findUnique({ where: { id: ROW_ID } });
  const value: StoredLaunch = row ? stored(row) : NEVER_SET;
  cached = { value, readAt: Date.now() };
  return value;
}

/** GET /launch-status: the mode in force now, the same for everyone. */
export async function launchStatus(prisma: PrismaClient, now = new Date()): Promise<LaunchStatus> {
  const stored = await readLaunchSetting(prisma);
  const mode = effectiveLaunchMode(stored, now);
  return {
    mode,
    launchAt: mode === "COUNTDOWN" ? stored.launchAt!.toISOString() : null,
    serverTime: now.toISOString(),
  };
}

/** A booking refused during the countdown. `message` is what the rider is shown. */
export class LaunchNotOpenError extends Error {
  readonly code = LAUNCH_NOT_OPEN_CODE;
  constructor(readonly launchAt: Date) {
    super(launchNotOpenMessage(launchAt));
    this.name = "LaunchNotOpenError";
  }
}

/** The launch time `userId` must wait for, or null: they can book now. */
async function launchToWaitFor(prisma: PrismaClient, userId: string, now: Date): Promise<Date | null> {
  const stored = await readLaunchSetting(prisma);
  if (effectiveLaunchMode(stored, now) !== "COUNTDOWN") return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isReviewDemo: true, earlyAccessAt: true },
  });
  return user && isLaunchExempt(user) ? null : stored.launchAt;
}

/** Whether this account may book now: anyone outside a countdown, and exempt accounts during one. */
export async function canRideNow(prisma: PrismaClient, userId: string, now = new Date()): Promise<boolean> {
  return (await launchToWaitFor(prisma, userId, now)) === null;
}

/**
 * Throws LaunchNotOpenError when `userId` may not book yet. Outside a
 * countdown it costs no query (the setting is cached), so it sits at the top
 * of createRide, before anything else is checked: during the countdown the
 * first thing a rider hears is when CampusRide opens.
 */
export async function assertCanBook(prisma: PrismaClient, userId: string, now = new Date()): Promise<void> {
  const launchAt = await launchToWaitFor(prisma, userId, now);
  if (launchAt) throw new LaunchNotOpenError(launchAt);
}

/** "COUNTDOWN to Saturday 14 November at 9:00 AM GMT (2026-11-14T09:00:00.000Z)", for the audit log. */
export function describeLaunch(setting: { mode: LaunchMode; launchAt: Date | null }): string {
  if (setting.mode !== "COUNTDOWN" || !setting.launchAt) return setting.mode;
  const at = setting.launchAt;
  return `COUNTDOWN to ${launchDay(at)} at ${launchClockTime(at)} GMT (${at.toISOString()})`;
}

export class LaunchSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchSettingError";
  }
}

/**
 * Sets the launch mode (admin site, PUT /admin/launch). A countdown needs a
 * launch time in the future; OFF and LIVE keep none. Audit row
 * "launch.update" with the before and after.
 */
export async function setLaunchMode(
  prisma: PrismaClient,
  actor: string,
  input: { mode: LaunchMode; launchAt: Date | null },
  now = new Date(),
): Promise<StoredLaunch> {
  if (input.mode === "COUNTDOWN") {
    if (!input.launchAt) throw new LaunchSettingError("A countdown needs a launch date and time.");
    if (input.launchAt.getTime() <= now.getTime()) {
      throw new LaunchSettingError("The launch time must be in the future.");
    }
  }
  const launchAt = input.mode === "COUNTDOWN" ? input.launchAt : null;

  clearLaunchCache();
  const before = await readLaunchSetting(prisma);
  const beforeNow = effectiveLaunchMode(before, now);
  const was =
    beforeNow === before.mode ? describeLaunch(before) : `${describeLaunch(before)}, already ${beforeNow}`;

  const [row] = await prisma.$transaction([
    prisma.launchSetting.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, mode: input.mode, launchAt, updatedBy: actor },
      update: { mode: input.mode, launchAt, updatedBy: actor },
    }),
    prisma.adminAuditLog.create({
      data: {
        actor,
        action: "launch.update",
        target: ROW_ID,
        reason: `${was} -> ${describeLaunch({ mode: input.mode, launchAt })}`,
      },
    }),
  ]);
  clearLaunchCache();
  return stored(row);
}

/** The launch push's Broadcast row (services/push/broadcast.ts): its key makes it once ever. */
export const LAUNCH_PUSH_KEY = "launch";

/**
 * The Settings switch "Send 'CampusRide is live!' when launch mode turns
 * Live". Turning it on is refused once CampusRide is already Live (there is
 * no launch moment left to announce; a late "it's live!" would confuse) and
 * once the push has gone out. Audit row "launch.push.enable" / "launch.push.disable".
 */
export async function setLaunchPush(
  prisma: PrismaClient,
  actor: string,
  enabled: boolean,
  now = new Date(),
): Promise<StoredLaunch> {
  clearLaunchCache();
  const before = await readLaunchSetting(prisma);
  if (enabled) {
    const sent = await prisma.broadcast.findUnique({
      where: { key: LAUNCH_PUSH_KEY },
      select: { createdAt: true },
    });
    if (sent) {
      throw new LaunchSettingError(
        `The launch push already went out (${sent.createdAt.toISOString()}). It is only ever sent once.`,
      );
    }
    if (effectiveLaunchMode(before, now) === "LIVE") {
      throw new LaunchSettingError(
        "CampusRide is already Live, so there is no launch moment left to announce. Use the Notifications page to send a message now.",
      );
    }
  }
  const [row] = await prisma.$transaction([
    prisma.launchSetting.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, launchPushEnabled: enabled, updatedBy: actor },
      update: { launchPushEnabled: enabled, updatedBy: actor },
    }),
    prisma.adminAuditLog.create({
      data: {
        actor,
        action: enabled ? "launch.push.enable" : "launch.push.disable",
        target: ROW_ID,
        reason: `while ${describeLaunch(before)}`,
      },
    }),
  ]);
  clearLaunchCache();
  return stored(row);
}

/** Riders the "everyone now" button reaches: real, open rider accounts without early access yet. */
const CURRENT_RIDERS_WITHOUT_ACCESS = {
  role: "RIDER" as const,
  deletedAt: null,
  isReviewDemo: false,
  earlyAccessAt: null,
};

/** Riders with early access now (open accounts, not the review demo). */
export function countEarlyAccess(prisma: PrismaClient): Promise<number> {
  return prisma.user.count({
    where: { role: "RIDER", deletedAt: null, isReviewDemo: false, earlyAccessAt: { not: null } },
  });
}

/**
 * Gives or takes away one rider's early access. Audit row
 * "early_access.grant" / "early_access.revoke" on the user. Giving it again
 * keeps the first time; nothing changes, nothing is logged.
 */
export async function setEarlyAccess(
  prisma: PrismaClient,
  actor: string,
  userId: string,
  enabled: boolean,
  now = new Date(),
): Promise<{ earlyAccessAt: Date | null; changed: boolean }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { earlyAccessAt: true } });
  if ((user.earlyAccessAt !== null) === enabled) return { earlyAccessAt: user.earlyAccessAt, changed: false };

  const earlyAccessAt = enabled ? now : null;
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { earlyAccessAt } }),
    prisma.adminAuditLog.create({
      data: { actor, action: enabled ? "early_access.grant" : "early_access.revoke", target: userId },
    }),
  ]);
  return { earlyAccessAt, changed: true };
}

/**
 * "Give early access to all current riders": every open rider account that
 * exists right now (the pilot testers). Riders who sign up afterwards don't
 * get it. One audit row, "early_access.grant_all", with how many.
 */
export async function grantEarlyAccessToAllRiders(
  prisma: PrismaClient,
  actor: string,
  now = new Date(),
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: CURRENT_RIDERS_WITHOUT_ACCESS,
      data: { earlyAccessAt: now },
    });
    await tx.adminAuditLog.create({
      data: {
        actor,
        action: "early_access.grant_all",
        target: "riders",
        reason: `${count} rider account(s) given early access`,
      },
    });
    return count;
  });
}
