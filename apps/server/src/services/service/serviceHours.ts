import type { PrismaClient } from "@prisma/client";
import { liveDriverWhere } from "../zones/driverLiveness";
import {
  DEFAULT_SERVICE_SETTINGS,
  NO_DRIVERS_ONLINE_CODE,
  SERVICE_CLOSED_CODE,
  WEEKDAY_NAMES,
  WEEKDAY_ORDER,
  overrideEnd,
  overrideInForce,
  readWeeklySchedule,
  serviceClosedText,
  serviceStateAt,
  serviceStatusFromState,
  type ServiceOverrideMode,
  type ServiceSettings,
  type ServiceState,
  type ServiceStatus,
  type WeeklySchedule,
} from "@rida/shared";
import { config } from "../../config";
import { logger } from "../../lib/logger";

/**
 * Service hours on the server (the rules are @rida/shared
 * service/serviceHours.ts): the one ServiceHoursSetting row, isServiceOpen —
 * the single source of truth for whether riders can book — the gate every
 * new booking passes (createRide), and the admin site's changes, each
 * written to AdminAuditLog in the same transaction as the change.
 *
 * Only NEW requests are refused. Nothing here cancels or touches a request
 * already searching or a trip going on: at closing time they carry on.
 * Review demo accounts and admins are never refused (store reviewers must
 * always be able to book).
 */

const ROW_ID = "service";

/** Read at most every 10 s per server (like launch mode); a change made here clears it at once. */
const CACHE_MS = 10_000;

export interface StoredServiceHours {
  settings: ServiceSettings;
  updatedAt: Date | null;
  /** User.id of the admin who last changed it. */
  updatedBy: string | null;
}

const NEVER_SET: StoredServiceHours = { settings: DEFAULT_SERVICE_SETTINGS, updatedAt: null, updatedBy: null };

type Row = {
  weekly: unknown;
  overrideMode: ServiceOverrideMode | null;
  overrideUntil: Date | null;
  closedMessage: string | null;
  blockWhenNoDrivers: boolean;
  updatedAt: Date;
  updatedBy: string | null;
};

function stored(row: Row): StoredServiceHours {
  const read = readWeeklySchedule(row.weekly);
  if ("error" in read) {
    // Never written by this code (saves are checked), but a hand-edited row
    // must not shut CampusRide: the default hours apply and it is logged.
    logger.error("service hours: stored schedule unreadable, using the default", { problem: read.error });
  }
  return {
    settings: {
      weekly: "weekly" in read ? read.weekly : DEFAULT_SERVICE_SETTINGS.weekly,
      override: row.overrideMode ? { mode: row.overrideMode, until: row.overrideUntil } : null,
      closedMessage: row.closedMessage?.trim() ? row.closedMessage.trim() : null,
      blockWhenNoDrivers: row.blockWhenNoDrivers,
    },
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

let cached: { value: StoredServiceHours; readAt: number } | null = null;

export function clearServiceHoursCache(): void {
  cached = null;
}

/** The stored settings (no row: the defaults). */
export async function readServiceHours(prisma: PrismaClient): Promise<StoredServiceHours> {
  if (cached && Date.now() - cached.readAt < CACHE_MS) return cached.value;
  const row = await prisma.serviceHoursSetting.findUnique({ where: { id: ROW_ID } });
  const value = row ? stored(row) : NEVER_SET;
  cached = { value, readAt: Date.now() };
  return value;
}

/**
 * Drivers riders could be offered to now: online and heard from in the last
 * 10 minutes (services/zones/driverLiveness.ts), approved, real (review demo
 * drivers only ever get review demo rides) and not deleted.
 */
export function countOnlineDrivers(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  return prisma.driver.count({
    where: { ...liveDriverWhere(now.getTime()), isApproved: true, user: { isReviewDemo: false, deletedAt: null } },
  });
}

/**
 * THE answer to "can riders book now?": the schedule, a manual override, and
 * (when the switch is on) whether any driver is online. Drivers are counted
 * only when it matters (open hours with the switch on).
 */
export async function isServiceOpen(prisma: PrismaClient, now = new Date()): Promise<ServiceState> {
  const { settings } = await readServiceHours(prisma);
  // First without drivers: closed hours need no count.
  const byHours = serviceStateAt({ ...settings, blockWhenNoDrivers: false }, now, 0);
  if (!byHours.open || !settings.blockWhenNoDrivers) return byHours;
  return serviceStateAt(settings, now, await countOnlineDrivers(prisma, now));
}

/** The wire form, for GET /app/config, GET /me/service-status and the socket event. */
export async function serviceStatus(prisma: PrismaClient, now = new Date()): Promise<ServiceStatus> {
  return serviceStatusFromState(await isServiceOpen(prisma, now), now);
}

/** Never refused by service hours: App Store / Google Play review demo accounts, and admins. */
export function isServiceHoursExempt(user: { role: string; isReviewDemo: boolean }): boolean {
  return user.isReviewDemo || user.role === "ADMIN";
}

/** A booking refused by service hours. `message` is what the rider is shown — by every app version. */
export class ServiceClosedError extends Error {
  readonly code: typeof SERVICE_CLOSED_CODE | typeof NO_DRIVERS_ONLINE_CODE;
  readonly nextOpenAt: Date | null;
  constructor(state: ServiceState, now: Date) {
    super(serviceClosedText(state, now));
    this.name = "ServiceClosedError";
    this.code = state.reason === "NO_DRIVERS" ? NO_DRIVERS_ONLINE_CODE : SERVICE_CLOSED_CODE;
    this.nextOpenAt = state.nextOpenAt;
  }
}

/**
 * Tests only: the gate is off in the server test suite (setup.ts), so the
 * hundreds of tests that book a ride don't depend on the time of day or on
 * an online driver; serviceHours.test.ts turns it on. Also turned off by the
 * dev-only shared-ride simulator. Refused in production.
 */
let gateOn = true;
export function setServiceHoursGateForTests(on: boolean): void {
  if (config.nodeEnv === "production") throw new Error("The service hours gate can't be switched off in production");
  gateOn = on;
}

/**
 * Throws ServiceClosedError when riders can't book now and `userId` isn't
 * exempt. Open, it costs one cached read (and the driver count when the
 * switch is on); closed, one more read for the account.
 */
export async function assertServiceOpen(prisma: PrismaClient, userId: string, now = new Date()): Promise<void> {
  if (!gateOn) return;
  const state = await isServiceOpen(prisma, now);
  if (state.open) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isReviewDemo: true } });
  if (user && isServiceHoursExempt(user)) return;
  throw new ServiceClosedError(state, now);
}

// ─── Admin Settings ─────────────────────────────────────────────────────────

export class ServiceHoursError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceHoursError";
  }
}

/** "Mon 08:00-17:00, Tue 08:00-17:00, …, Sun closed", for the audit log. */
export function describeWeekly(weekly: WeeklySchedule): string {
  return WEEKDAY_ORDER.map((day) => {
    const hours = weekly[day];
    const name = WEEKDAY_NAMES[day]!.slice(0, 3);
    return hours ? `${name} ${hours.open}-${hours.close}` : `${name} closed`;
  }).join(", ");
}

function describeSettings(s: ServiceSettings): string {
  return [
    describeWeekly(s.weekly),
    `no-drivers block ${s.blockWhenNoDrivers ? "on" : "off"}`,
    `message ${s.closedMessage ? JSON.stringify(s.closedMessage) : "none"}`,
  ].join("; ");
}

function describeOverride(mode: ServiceOverrideMode | null, until: Date | null): string {
  if (!mode) return "follow the schedule";
  return `${mode === "OPEN" ? "Open now" : "Close now"} until ${until ? until.toISOString() : "changed by hand"}`;
}

export interface ServiceHoursInput {
  weekly: unknown;
  closedMessage: string | null;
  blockWhenNoDrivers: boolean;
}

/**
 * Saves the schedule, the closed message and the no-drivers switch (admin
 * Settings). An override in force keeps going, its end worked out again
 * from the new schedule. Audit row "service_hours.update", before -> after.
 */
export async function saveServiceHours(
  prisma: PrismaClient,
  actor: string,
  input: ServiceHoursInput,
  now = new Date(),
): Promise<StoredServiceHours> {
  const read = readWeeklySchedule(input.weekly);
  if ("error" in read) throw new ServiceHoursError(read.error);
  const closedMessage = input.closedMessage?.trim() ? input.closedMessage.trim() : null;

  clearServiceHoursCache();
  const before = await readServiceHours(prisma);
  const override = overrideInForce(before.settings.override, now) ? before.settings.override : null;
  const overrideMode = override?.mode ?? null;
  const overrideUntil = override ? overrideEnd(read.weekly, override.mode, now) : null;
  const after: ServiceSettings = {
    weekly: read.weekly,
    override: overrideMode ? { mode: overrideMode, until: overrideUntil } : null,
    closedMessage,
    blockWhenNoDrivers: input.blockWhenNoDrivers,
  };

  const data = {
    weekly: read.weekly as unknown as object,
    overrideMode,
    overrideUntil,
    closedMessage,
    blockWhenNoDrivers: input.blockWhenNoDrivers,
    updatedBy: actor,
  };
  const [row] = await prisma.$transaction([
    prisma.serviceHoursSetting.upsert({ where: { id: ROW_ID }, create: { id: ROW_ID, ...data }, update: data }),
    prisma.adminAuditLog.create({
      data: {
        actor,
        action: "service_hours.update",
        target: ROW_ID,
        reason: `${describeSettings(before.settings)} -> ${describeSettings(after)}${
          overrideMode ? `; override now ${describeOverride(overrideMode, overrideUntil)}` : ""
        }`,
      },
    }),
  ]);
  clearServiceHoursCache();
  return stored(row);
}

/**
 * "Open now" / "Close now" (mode), or back to the schedule (null). The
 * override ends by itself at the next scheduled change: Close now at the
 * next opening, Open now at the next closing. Audit row "service_hours.override".
 */
export async function setServiceOverride(
  prisma: PrismaClient,
  actor: string,
  mode: ServiceOverrideMode | null,
  now = new Date(),
): Promise<StoredServiceHours> {
  clearServiceHoursCache();
  const before = await readServiceHours(prisma);
  const until = mode ? overrideEnd(before.settings.weekly, mode, now) : null;
  const wasOverride = overrideInForce(before.settings.override, now) ? before.settings.override : null;

  const data = { overrideMode: mode, overrideUntil: until, updatedBy: actor };
  const [row] = await prisma.$transaction([
    prisma.serviceHoursSetting.upsert({
      where: { id: ROW_ID },
      create: {
        id: ROW_ID,
        weekly: before.settings.weekly as unknown as object,
        closedMessage: before.settings.closedMessage,
        blockWhenNoDrivers: before.settings.blockWhenNoDrivers,
        ...data,
      },
      update: data,
    }),
    prisma.adminAuditLog.create({
      data: {
        actor,
        action: "service_hours.override",
        target: ROW_ID,
        reason: `${describeOverride(wasOverride?.mode ?? null, wasOverride?.until ?? null)} -> ${describeOverride(mode, until)}`,
      },
    }),
  ]);
  clearServiceHoursCache();
  return stored(row);
}

// ─── "Notify me when you open" ─────────────────────────────────────────────

export async function isWaitingForOpening(prisma: PrismaClient, userId: string): Promise<boolean> {
  return (await prisma.serviceOpenWaiter.count({ where: { userId } })) > 0;
}

export async function addOpeningWaiter(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.serviceOpenWaiter.upsert({ where: { userId }, create: { userId }, update: {} });
}

export async function removeOpeningWaiter(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.serviceOpenWaiter.deleteMany({ where: { userId } });
}

export function countOpeningWaiters(prisma: PrismaClient): Promise<number> {
  return prisma.serviceOpenWaiter.count();
}

/**
 * Empties the list and returns who was on it, in one statement: each row is
 * deleted (and so claimed) by exactly one caller, so two servers checking at
 * the same moment never both push the same rider.
 */
export async function claimOpeningWaiters(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ userId: string }[]>`DELETE FROM "ServiceOpenWaiter" RETURNING "userId"`;
  return rows.map((r) => r.userId);
}
