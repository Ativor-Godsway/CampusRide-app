-- Pickup wait fee (2026-11-25). Additive only.

-- The rider's pickup wait on their seat (services/ride/waitFee.ts).
ALTER TABLE "RidePassenger" ADD COLUMN "waitStartedAt" TIMESTAMP(3);
ALTER TABLE "RidePassenger" ADD COLUMN "freeWaitEndsAt" TIMESTAMP(3);
ALTER TABLE "RidePassenger" ADD COLUMN "waitFeeAmount" INTEGER;
ALTER TABLE "RidePassenger" ADD COLUMN "riderWarnedAt" TIMESTAMP(3);
ALTER TABLE "RidePassenger" ADD COLUMN "waitFee" INTEGER;
ALTER TABLE "RidePassenger" ADD COLUMN "noShowOpensAt" TIMESTAMP(3);

-- When the rider's app first showed it has the wait timer.
ALTER TABLE "User" ADD COLUMN "waitFeeAppAt" TIMESTAMP(3);

-- The settings (no row = 150 s free, GH₵2, no-show after 5 min).
CREATE TABLE "WaitFeeSetting" (
    "id" TEXT NOT NULL DEFAULT 'wait',
    "freeWaitSeconds" INTEGER NOT NULL DEFAULT 150,
    "feePesewas" INTEGER NOT NULL DEFAULT 200,
    "noShowMinutes" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "WaitFeeSetting_pkey" PRIMARY KEY ("id")
);
