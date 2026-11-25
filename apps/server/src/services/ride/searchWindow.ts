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

/** The search window now, in ms. */
export function searchWindowMs(): number {
  return windowSeconds * 1000;
}

export interface SearchWindowSetting {
  searchWindowSeconds: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The stored setting (no row: the default), and keeps it in memory. */
export async function readSearchWindow(prisma: PrismaClient): Promise<SearchWindowSetting> {
  const row = await prisma.dispatchSetting.findUnique({ where: { id: SETTING_ID } });
  windowSeconds = row?.searchWindowSeconds ?? DEFAULT_SEARCH_WINDOW_SECONDS;
  return { searchWindowSeconds: windowSeconds, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
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

/** Tests only: set the window without the database. */
export function setSearchWindowForTests(seconds: number = DEFAULT_SEARCH_WINDOW_SECONDS): void {
  windowSeconds = seconds;
}
