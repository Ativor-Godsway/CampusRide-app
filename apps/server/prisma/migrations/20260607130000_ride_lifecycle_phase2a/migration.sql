-- Phase 2a: Ride Lifecycle & State Machine
-- Adds cancelReason to Ride and lockedFare to RidePassenger.

-- CreateEnum
CREATE TYPE "RideCancelReason" AS ENUM ('RIDER_CANCELLED', 'DRIVER_BACKED_OUT', 'NO_DRIVERS_AVAILABLE', 'ALL_PASSENGERS_LEFT');

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN "cancelReason" "RideCancelReason";

-- AlterTable
ALTER TABLE "RidePassenger" ADD COLUMN "lockedFare" INTEGER;
