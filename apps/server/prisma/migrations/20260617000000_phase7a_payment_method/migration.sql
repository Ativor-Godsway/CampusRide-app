-- Phase 7a: Payment method choice (CASH | MOMO) on Ride
-- + CommissionLedger for tracking 15% platform commission on CASH rides

-- 1. New enum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'MOMO');

-- 2. Add paymentMethod to Ride (default MOMO preserves existing rows)
ALTER TABLE "Ride" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'MOMO';

-- 3. CommissionLedger table (one row per CASH ride, created at completion)
CREATE TABLE "CommissionLedger" (
    "id"            TEXT NOT NULL,
    "driverUserId"  TEXT NOT NULL,
    "rideId"        TEXT NOT NULL,
    "amountPesewas" INTEGER NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionLedger_pkey" PRIMARY KEY ("id")
);

-- 4. Unique + index constraints
CREATE UNIQUE INDEX "CommissionLedger_rideId_key" ON "CommissionLedger"("rideId");
CREATE INDEX "CommissionLedger_driverUserId_idx" ON "CommissionLedger"("driverUserId");

-- 5. Foreign keys
ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_driverUserId_fkey"
    FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommissionLedger" ADD CONSTRAINT "CommissionLedger_rideId_fkey"
    FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;
