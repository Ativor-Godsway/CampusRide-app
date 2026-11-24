-- Dispatch fixes + far-trip pricing (2026-11-24). Additive only.

-- 1. Driver liveness: when the app was last heard from, and when the server
--    set the driver offline for silence. Both start empty: until a driver's
--    app is heard from after the deploy, they don't count as online.
ALTER TABLE "Driver" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
ALTER TABLE "Driver" ADD COLUMN "autoOfflineAt" TIMESTAMP(3);

-- 2. The two far ends of campus. A Shared trip from one to the other pays
--    the far price. Each place: NORTH, SOUTH or none (admin-editable).
CREATE TYPE "FarEnd" AS ENUM ('NORTH', 'SOUTH');
ALTER TABLE "Place" ADD COLUMN "farEnd" "FarEnd";

-- North: Pentagon (every block, its food court), TF Hall, Bani and Evandy
-- Hostels — with their annexes and "Other spot near …" places (matched by
-- name) — and the hostels right beside them.
UPDATE "Place" SET "farEnd" = 'NORTH'
WHERE "name" ILIKE '%Pentagon%'
   OR "name" ILIKE '%Topp Nelson Yankah%'
   OR "name" ILIKE '%TF Hall%'
   OR "name" ILIKE '%Bani Hostel%'
   OR "name" ILIKE '%Evandy%'
   OR "name" IN ('Nairobi Courts', 'Kampala Courts', 'Dar es Salaam Courts', 'Addis Ababa Courts');

-- South (Diaspora): the four halls — with their annexes and "Other spot near
-- …" places — and the places right beside them inside the complex.
UPDATE "Place" SET "farEnd" = 'SOUTH'
WHERE "name" ILIKE '%Jean Nelson Aka%'
   OR "name" ILIKE '%Elizabeth Frances Sey%'
   OR "name" ILIKE '%Elizabeth Sey Hall%'
   OR "name" ILIKE '%Hilla Limann%'
   OR "name" ILIKE '%Kwapong%'
   OR "name" IN ('Elizabeth Sey Pharmacy', 'Games Arena', 'Bervels', 'Tickels Restaurant');

-- 3. The Shared seat prices (no row = GH₵7 / GH₵9 defaults).
CREATE TABLE "FarePricingSetting" (
    "id" TEXT NOT NULL DEFAULT 'fares',
    "sharedPesewas" INTEGER NOT NULL DEFAULT 700,
    "sharedFarPesewas" INTEGER NOT NULL DEFAULT 900,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "FarePricingSetting_pkey" PRIMARY KEY ("id")
);

-- 4. Refused bookings, anonymous.
CREATE TABLE "RefusedBooking" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(40) NOT NULL,
    "stage" VARCHAR(10) NOT NULL,
    "rideType" VARCHAR(10),
    "pickupLabel" VARCHAR(160),
    "pickupZoneId" TEXT,
    "dropoffLabel" VARCHAR(160),
    "dropoffZoneId" TEXT,

    CONSTRAINT "RefusedBooking_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RefusedBooking_createdAt_idx" ON "RefusedBooking"("createdAt");
