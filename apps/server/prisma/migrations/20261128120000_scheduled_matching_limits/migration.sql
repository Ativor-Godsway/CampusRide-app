-- Scheduled rides, matching by direction (2026-11-28). Additive only: three
-- admin limits on ScheduleSetting (@rida/shared rides/scheduled.ts
-- bookingFitsCar). No row, or an existing row: the defaults.
ALTER TABLE "ScheduleSetting" ADD COLUMN "maxExtraMeters" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "ScheduleSetting" ADD COLUMN "sparseExtraMeters" INTEGER NOT NULL DEFAULT 1500;
ALTER TABLE "ScheduleSetting" ADD COLUMN "maxExtraMinutes" INTEGER NOT NULL DEFAULT 5;
