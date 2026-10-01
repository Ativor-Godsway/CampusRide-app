-- Stop-based trip screen + precomputed road routes.
--
-- PURELY ADDITIVE: two NULLABLE columns on "RidePassenger" and one new table.
-- No existing row or column changes, so this is safe to apply to production
-- BEFORE the server code that uses them is deployed. (Prisma selects every
-- column, so the new code must never run against a database without them.)

-- When the driver reached this rider's pickup; drives the wait timer and the
-- 3-minute "rider didn't show" rule.
ALTER TABLE "RidePassenger" ADD COLUMN "arrivedAt" TIMESTAMP(3);
-- Set when the seat was cancelled because the rider didn't show.
ALTER TABLE "RidePassenger" ADD COLUMN "noShowAt" TIMESTAMP(3);

-- Road routes between campus zones, filled once by
-- src/scripts/precomputeZoneRoutes.ts.
CREATE TABLE "ZoneRoute" (
    "id" TEXT NOT NULL,
    "fromZoneId" TEXT NOT NULL,
    "toZoneId" TEXT NOT NULL,
    "polyline" TEXT NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZoneRoute_fromZoneId_toZoneId_key" ON "ZoneRoute"("fromZoneId", "toZoneId");

ALTER TABLE "ZoneRoute" ADD CONSTRAINT "ZoneRoute_fromZoneId_fkey" FOREIGN KEY ("fromZoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ZoneRoute" ADD CONSTRAINT "ZoneRoute_toZoneId_fkey" FOREIGN KEY ("toZoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
