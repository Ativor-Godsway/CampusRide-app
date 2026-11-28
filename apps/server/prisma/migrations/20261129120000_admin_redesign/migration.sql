-- Admin redesign (2026-11-29). Additive only: no existing row changes meaning.
-- services/commission/settings.ts (rate + waiver), services/admin/payouts.ts (top-ups).

-- The commission rate and the waiver (the commission-free launch).
ALTER TABLE "CommissionSetting" ADD COLUMN "rateBps" INTEGER NOT NULL DEFAULT 1500;
ALTER TABLE "CommissionSetting" ADD COLUMN "waived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CommissionSetting" ADD COLUMN "waivedFrom" TIMESTAMP(3);

-- Each trip's commission: the rate used, and whether it fell in a waiver (never owed).
ALTER TABLE "CommissionLedger" ADD COLUMN "rateBps" INTEGER;
ALTER TABLE "CommissionLedger" ADD COLUMN "waived" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "CommissionLedger_createdAt_idx" ON "CommissionLedger"("createdAt");

-- Top-ups CampusRide pays drivers on top of their fares (the launch guarantee).
CREATE TYPE "TopUpMethod" AS ENUM ('MOMO', 'CASH');

CREATE TABLE "DriverTopUp" (
    "id" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "amountPesewas" INTEGER NOT NULL,
    "paidOn" TIMESTAMP(3) NOT NULL,
    "method" "TopUpMethod" NOT NULL,
    "note" VARCHAR(500),
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "removedReason" VARCHAR(500),

    CONSTRAINT "DriverTopUp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriverTopUp_paidOn_idx" ON "DriverTopUp"("paidOn");
CREATE INDEX "DriverTopUp_driverUserId_paidOn_idx" ON "DriverTopUp"("driverUserId", "paidOn");

ALTER TABLE "DriverTopUp" ADD CONSTRAINT "DriverTopUp_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
