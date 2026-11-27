import type { PrismaClient } from "@prisma/client";
import { DEFAULT_SCHEDULE_SETTINGS, SCHEDULE_SETTING_FIELDS, readScheduleSettings, type ScheduleSettings } from "@rida/shared";
import { logger } from "../../lib/logger";

/**
 * Scheduled ride settings (2026-11-27, admin Settings → Scheduled rides):
 * every number in @rida/shared rides/scheduled.ts. Kept in memory like the
 * search window: loaded at start, every minute (index.ts) and on save.
 */

const SETTING_ID = "schedule";
let current: ScheduleSettings = { ...DEFAULT_SCHEDULE_SETTINGS };

/** The settings now (from memory). */
export function scheduleSettings(): ScheduleSettings {
  return current;
}

export interface StoredScheduleSettings extends ScheduleSettings {
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The stored row (no row: the defaults), and keeps it in memory. */
export async function readScheduleSettingsRow(prisma: PrismaClient): Promise<StoredScheduleSettings> {
  const row = await prisma.scheduleSetting.findUnique({ where: { id: SETTING_ID } });
  current = readScheduleSettings(row);
  return { ...current, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
}

/** Reloads it, never throwing (the minute timer). */
export function refreshScheduleSettings(prisma: PrismaClient): Promise<void> {
  return readScheduleSettingsRow(prisma).then(
    () => undefined,
    (err) => logger.warn("schedule settings: reload failed", { err }),
  );
}

/** Saves them with an audit row naming what changed (checked by the caller: scheduleSettingsProblem). */
export async function saveScheduleSettings(prisma: PrismaClient, next: ScheduleSettings, adminId: string): Promise<StoredScheduleSettings> {
  const before = current;
  const changes = [
    before.enabled !== next.enabled ? `enabled ${before.enabled} → ${next.enabled}` : null,
    before.introEnabled !== next.introEnabled ? `intro ${before.introEnabled} → ${next.introEnabled}` : null,
    ...SCHEDULE_SETTING_FIELDS.map((f) => (before[f.key] !== next[f.key] ? `${f.key} ${before[f.key]} → ${next[f.key]}` : null)),
  ].filter(Boolean);
  const data = { ...next, updatedBy: adminId };
  await prisma.$transaction([
    prisma.scheduleSetting.upsert({ where: { id: SETTING_ID }, create: { id: SETTING_ID, ...data }, update: data }),
    prisma.adminAuditLog.create({
      data: {
        actor: adminId,
        action: "schedule.settings",
        target: SETTING_ID,
        reason: (changes.length ? changes.join("; ") : "no change").slice(0, 1000),
      },
    }),
  ]);
  return readScheduleSettingsRow(prisma);
}

/** Tests only: set the settings without the database. */
export function setScheduleSettingsForTests(next: Partial<ScheduleSettings> = {}): void {
  current = { ...DEFAULT_SCHEDULE_SETTINGS, ...next };
}
