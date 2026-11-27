-- Fill moving cars first + auto-add (2026-11-28). Additive only.
-- services/ride/movingFirst.ts; rules in @rida/shared rides/movingCar.ts.

-- What the moving-car step did with each request (analysis), and the short
-- exclusive hold while one moving car is offered it.
ALTER TABLE "Ride" ADD COLUMN "movingStep" VARCHAR(12);
ALTER TABLE "Ride" ADD COLUMN "movingHoldDriverId" TEXT;
ALTER TABLE "Ride" ADD COLUMN "movingHoldUntil" TIMESTAMP(3);
ALTER TABLE "Ride" ADD COLUMN "movingDetourMeters" INTEGER;

-- An auto-added seat: its undo window, where an undone rider went, the pickup estimate.
ALTER TABLE "RidePassenger" ADD COLUMN "autoAddUndoUntil" TIMESTAMP(3);
ALTER TABLE "RidePassenger" ADD COLUMN "undoneRequestRideId" TEXT;
ALTER TABLE "RidePassenger" ADD COLUMN "movingJoinEtaMin" INTEGER;

-- The driver's "Auto-add riders on my way" (null = the admin default) and whether their app can show it.
ALTER TABLE "Driver" ADD COLUMN "autoAddRiders" BOOLEAN;
ALTER TABLE "Driver" ADD COLUMN "autoAddAppAt" TIMESTAMP(3);

-- Admin switches: the whole step, and the auto-add default.
ALTER TABLE "DispatchSetting" ADD COLUMN "movingFirstEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "DispatchSetting" ADD COLUMN "autoAddDefault" BOOLEAN NOT NULL DEFAULT true;
