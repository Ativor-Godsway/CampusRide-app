-- Admin dashboard v2 (routes/adminDashboard.ts). All additive:
--   * DriverCashPayment: the ledger of cash drivers hand over against the
--     15% commission they owe (never edited or deleted; a mistake is a
--     reversal row);
--   * SosEvent: each SOS a rider raises, and when an admin handled it;
--   * three nullable columns on Driver (an admin's suspension, with why);
--   * indexes for the dashboard's period queries (Ride.createdAt,
--     Ride.completedAt, User.createdAt, Rating.createdAt).
-- New tables start empty; nothing existing is changed or rewritten. Safe to
-- apply before the code that uses it is deployed: the running server reads
-- and writes none of it. Building the indexes takes a moment on a table the
-- size of today's Ride table (a few thousand rows).
-- CreateEnum
CREATE TYPE "CashPaymentMethod" AS ENUM ('CASH', 'MOMO', 'OTHER');

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedBy" TEXT,
ADD COLUMN     "suspendedReason" VARCHAR(500);

-- CreateTable
CREATE TABLE "DriverCashPayment" (
    "id" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "amountPesewas" INTEGER NOT NULL,
    "method" "CashPaymentMethod" NOT NULL,
    "note" VARCHAR(500),
    "paidAt" TIMESTAMP(3) NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversesId" TEXT,
    "reversalReason" VARCHAR(500),

    CONSTRAINT "DriverCashPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SosEvent" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rideStatus" VARCHAR(30) NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "hasContact" BOOLEAN NOT NULL DEFAULT false,
    "smsDelivered" BOOLEAN NOT NULL DEFAULT false,
    "supportNotified" BOOLEAN NOT NULL DEFAULT false,
    "handledAt" TIMESTAMP(3),
    "handledBy" TEXT,
    "handledNote" VARCHAR(1000),

    CONSTRAINT "SosEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverCashPayment_reversesId_key" ON "DriverCashPayment"("reversesId");

-- CreateIndex
CREATE INDEX "DriverCashPayment_driverUserId_paidAt_idx" ON "DriverCashPayment"("driverUserId", "paidAt");

-- CreateIndex
CREATE INDEX "DriverCashPayment_paidAt_idx" ON "DriverCashPayment"("paidAt");

-- CreateIndex
CREATE INDEX "SosEvent_createdAt_idx" ON "SosEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SosEvent_handledAt_idx" ON "SosEvent"("handledAt");

-- CreateIndex
CREATE INDEX "SosEvent_rideId_idx" ON "SosEvent"("rideId");

-- CreateIndex
CREATE INDEX "Rating_createdAt_idx" ON "Rating"("createdAt");

-- CreateIndex
CREATE INDEX "Ride_createdAt_idx" ON "Ride"("createdAt");

-- CreateIndex
CREATE INDEX "Ride_completedAt_idx" ON "Ride"("completedAt");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- AddForeignKey
ALTER TABLE "DriverCashPayment" ADD CONSTRAINT "DriverCashPayment_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverCashPayment" ADD CONSTRAINT "DriverCashPayment_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "DriverCashPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SosEvent" ADD CONSTRAINT "SosEvent_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SosEvent" ADD CONSTRAINT "SosEvent_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

