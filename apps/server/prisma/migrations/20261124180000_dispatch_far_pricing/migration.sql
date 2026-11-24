-- Dispatch fixes + far-trip pricing (2026-11-24). Additive only.

-- 1. Driver liveness: when the app was last heard from, and when the server
--    set the driver offline for silence. Both start empty: until a driver's
--    app is heard from after the deploy, they don't count as online.
ALTER TABLE "Driver" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
ALTER TABLE "Driver" ADD COLUMN "autoOfflineAt" TIMESTAMP(3);

-- 2. The far area, starting with the six places and every annex or
--    "Other spot near" variant of them (matched by name).
ALTER TABLE "Place" ADD COLUMN "inFarArea" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Place" SET "inFarArea" = true
WHERE "name" ILIKE '%Jean Nelson Aka%'
   OR "name" ILIKE '%Elizabeth Frances Sey%'
   OR "name" ILIKE '%Elizabeth Sey Hall%'
   OR "name" ILIKE '%Hilla Limann%'
   OR "name" ILIKE '%Kwapong%'
   OR "name" ILIKE '%Bani Hostel%'
   OR "name" ILIKE '%Evandy%';

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
