import type { PrismaClient } from "@prisma/client";
import { DEFAULT_SEARCH_WINDOW_SECONDS } from "@rida/shared";
import { logger } from "../../lib/logger";

/**
 * How long a request searches for a driver (2026-11-25): an admin setting
 * (DispatchSetting, Settings → Ride requests), 7 minutes by default. After
 * it the rider sees "no driver found" (services/ride/timeouts.ts).
 *
 * Read synchronously everywhere (dispatch, the request lists, timeouts) from
 * this server's memory, which loads the stored value at start, every minute
 * (index.ts) and at once when an admin saves. One instance, so that's exact
 * for this server; until the first load, the default.
 */

const SETTING_ID = "dispatch";
let windowSeconds = DEFAULT_SEARCH_WINDOW_SECONDS;
/** Fill moving cars first (services/ride/movingFirst.ts): the whole step, and the auto-add default. */
let moving = { movingFirstEnabled: true, autoAddDefault: true };

/** The moving-car step's switches now (from memory). */
export function movingFirstSettings(): { movingFirstEnabled: boolean; autoAddDefault: boolean } {
  return moving;
}

/** The search window now, in ms. */
export function searchWindowMs(): number {
  return windowSeconds * 1000;
}

export interface SearchWindowSetting {
  searchWindowSeconds: number;
  movingFirstEnabled: boolean;
  autoAddDefault: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The stored setting (no row: the default), and keeps it in memory. */
export async function readSearchWindow(prisma: PrismaClient): Promise<SearchWindowSetting> {
  const row = await prisma.dispatchSetting.findUnique({ where: { id: SETTING_ID } });
  windowSeconds = row?.searchWindowSeconds ?? DEFAULT_SEARCH_WINDOW_SECONDS;
  moving = { movingFirstEnabled: row?.movingFirstEnabled ?? true, autoAddDefault: row?.autoAddDefault ?? true };
  return { searchWindowSeconds: windowSeconds, ...moving, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
}

/** Reloads it, never throwing (the minute timer). */
export function refreshSearchWindow(prisma: PrismaClient): Promise<void> {
  return readSearchWindow(prisma).then(
    () => undefined,
    (err) => logger.warn("search window: reload failed", { err }),
  );
}

/** Saves it with an audit row (bounds checked by the caller: searchWindowProblem). */
export async function saveSearchWindow(prisma: PrismaClient, seconds: number, adminId: string): Promise<SearchWindowSetting> {
  const before = windowSeconds;
  await prisma.$transaction([
    prisma.dispatchSetting.upsert({
      where: { id: SETTING_ID },
      create: { id: SETTING_ID, searchWindowSeconds: seconds, updatedBy: adminId },
      update: { searchWindowSeconds: seconds, updatedBy: adminId },
    }),
    prisma.adminAuditLog.create({
      data: { actor: adminId, action: "dispatch.search_window", target: SETTING_ID, reason: `${before} s → ${seconds} s` },
    }),
  ]);
  return readSearchWindow(prisma);
}

/** Saves the moving-car switches with an audit row. */
export async function saveMovingFirstSettings(
  prisma: PrismaClient,
  next: { movingFirstEnabled: boolean; autoAddDefault: boolean },
  adminId: string,
): Promise<SearchWindowSetting> {
  const before = moving;
  await prisma.$transaction([
    prisma.dispatchSetting.upsert({
      where: { id: SETTING_ID },
      create: { id: SETTING_ID, ...next, updatedBy: adminId },
      update: { ...next, updatedBy: adminId },
    }),
    prisma.adminAuditLog.create({
      data: {
        actor: adminId,
        action: "dispatch.moving_first",
        target: SETTING_ID,
        reason: `moving cars first ${before.movingFirstEnabled} → ${next.movingFirstEnabled}; auto-add default ${before.autoAddDefault} → ${next.autoAddDefault}`,
      },
    }),
  ]);
  return readSearchWindow(prisma);
}

/** Tests only: the moving-car switches without the database. */
export function setMovingFirstForTests(next: Partial<{ movingFirstEnabled: boolean; autoAddDefault: boolean }> = {}): void {
  moving = { movingFirstEnabled: true, autoAddDefault: true, ...next };
}

/** Tests only: set the window without the database. */
export function setSearchWindowForTests(seconds: number = DEFAULT_SEARCH_WINDOW_SECONDS): void {
  windowSeconds = seconds;
}
