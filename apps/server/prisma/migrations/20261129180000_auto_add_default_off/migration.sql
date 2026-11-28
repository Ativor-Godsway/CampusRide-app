-- "Auto-add riders on my way" OFF by default (2026-11-28).
-- The admin default becomes off, now and for a database without the row yet.
-- Drivers keep their own choice: Driver."autoAddRiders" is null for everyone
-- who never touched the switch (they now follow the default: off) and true
-- only for a driver who turned it on themselves, so no driver row changes.
ALTER TABLE "DispatchSetting" ALTER COLUMN "autoAddDefault" SET DEFAULT false;
UPDATE "DispatchSetting" SET "autoAddDefault" = false;
