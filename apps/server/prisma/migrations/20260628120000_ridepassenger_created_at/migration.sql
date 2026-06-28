-- AlterTable
-- Stable join-order key for the driver's per-passenger list. Additive and
-- non-destructive: existing rows take CURRENT_TIMESTAMP at migration time.
ALTER TABLE "RidePassenger" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
