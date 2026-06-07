-- Phase 2b: Broadcast Dispatch, Atomic Claim & 90s Timeout
-- Adds AWAITING_RIDER_DECISION to RideStatus and broadcast/decision timestamps to Ride.

-- AlterEnum
ALTER TYPE "RideStatus" ADD VALUE 'AWAITING_RIDER_DECISION';

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN "broadcastStartedAt" TIMESTAMP(3);
ALTER TABLE "Ride" ADD COLUMN "decisionStartedAt" TIMESTAMP(3);
