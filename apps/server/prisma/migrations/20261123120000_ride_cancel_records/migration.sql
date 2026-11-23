-- Ride cancel fixes (2026-11-23). Additive only — safe to apply before the
-- server that uses it is deployed: the running server never reads the new
-- table, and nothing writes the new enum value until the new code does.
--
-- * DriverCancellation: one row per "Cancel pickup" by a driver (reason,
--   optional note, and the request the rider was moved to). Counted as the
--   driver's cancellation in admin.
-- * RideCancelReason.ADMIN_CANCELLED: a ride an admin cancelled from the
--   admin site (who and why: AdminAuditLog, action "ride.cancel").

-- CreateEnum
CREATE TYPE "DriverCancelReason" AS ENUM ('RIDER_NOT_RESPONDING', 'CANT_REACH_PICKUP', 'CAR_PROBLEM', 'SAFETY_CONCERN', 'OTHER');

-- AlterEnum
ALTER TYPE "RideCancelReason" ADD VALUE 'ADMIN_CANCELLED';

-- CreateTable
CREATE TABLE "DriverCancellation" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "ridePassengerId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "reason" "DriverCancelReason",
    "note" VARCHAR(200),
    "rebookedRideId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverCancellation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverCancellation_driverUserId_createdAt_idx" ON "DriverCancellation"("driverUserId", "createdAt");

-- CreateIndex
CREATE INDEX "DriverCancellation_createdAt_idx" ON "DriverCancellation"("createdAt");

-- CreateIndex
CREATE INDEX "DriverCancellation_rideId_idx" ON "DriverCancellation"("rideId");

-- CreateIndex
CREATE INDEX "DriverCancellation_rebookedRideId_idx" ON "DriverCancellation"("rebookedRideId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverCancellation_ridePassengerId_driverUserId_key" ON "DriverCancellation"("ridePassengerId", "driverUserId");

