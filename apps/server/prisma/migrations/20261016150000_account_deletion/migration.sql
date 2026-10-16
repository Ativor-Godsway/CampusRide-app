-- Account deletion with a retention period: a code purpose to confirm it, and
-- a table holding a closed account's kept details until they are erased.
-- Only adds things: nothing existing is changed or removed.
ALTER TYPE "OtpPurpose" ADD VALUE 'ACCOUNT_DELETION';

CREATE TABLE "AccountDeletion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAfter" TIMESTAMP(3) NOT NULL,
    "purgedAt" TIMESTAMP(3),
    "keptName" TEXT,
    "keptPhone" TEXT,
    "keptPlate" TEXT,
    "keptPhotoUrl" TEXT,

    CONSTRAINT "AccountDeletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountDeletion_userId_key" ON "AccountDeletion"("userId");

CREATE INDEX "AccountDeletion_purgeAfter_idx" ON "AccountDeletion"("purgeAfter");

ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
