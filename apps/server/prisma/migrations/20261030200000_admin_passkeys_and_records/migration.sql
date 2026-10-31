-- Admin passkeys, and records for the future admin dashboard
-- (services/auth/passkeys.ts, services/stats). All additive:
--   * AdminPasskey: admins' passkeys (public keys only);
--   * DriverOnlineSession, RideOffer, DriverLocationPoint: driver online
--     sessions, ride offers and their outcomes, and a sampled driver location
--     trail (the server deletes points after 90 days);
--   * three nullable timestamps on Ride (matched, cancelled, first "no
--     driver found").
-- New tables start empty; nothing existing is changed or rewritten. Safe to
-- apply before the code that uses it is deployed: the running server reads
-- and writes none of it.
-- CreateEnum
CREATE TYPE "DriverSessionEnd" AS ENUM ('OFFLINE', 'TIMEOUT', 'ADMIN', 'ACCOUNT_CLOSED');

-- CreateEnum
CREATE TYPE "RideOfferOutcome" AS ENUM ('ACCEPTED', 'DECLINED', 'TIMED_OUT', 'TAKEN', 'CANCELLED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "matchedAt" TIMESTAMP(3),
ADD COLUMN     "noDriverFoundAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DriverOnlineSession" (
    "id" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" "DriverSessionEnd",

    CONSTRAINT "DriverOnlineSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RideOffer" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "offeredAt" TIMESTAMP(3) NOT NULL,
    "outcome" "RideOfferOutcome",
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "RideOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverLocationPoint" (
    "id" BIGSERIAL NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "onTrip" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DriverLocationPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminPasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" VARCHAR(512) NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" VARCHAR(100),
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "name" VARCHAR(60) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AdminPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverOnlineSession_driverUserId_startedAt_idx" ON "DriverOnlineSession"("driverUserId", "startedAt");

-- CreateIndex
CREATE INDEX "DriverOnlineSession_endedAt_idx" ON "DriverOnlineSession"("endedAt");

-- CreateIndex
CREATE INDEX "RideOffer_driverUserId_offeredAt_idx" ON "RideOffer"("driverUserId", "offeredAt");

-- CreateIndex
CREATE INDEX "RideOffer_offeredAt_idx" ON "RideOffer"("offeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RideOffer_rideId_driverUserId_key" ON "RideOffer"("rideId", "driverUserId");

-- CreateIndex
CREATE INDEX "DriverLocationPoint_driverUserId_recordedAt_idx" ON "DriverLocationPoint"("driverUserId", "recordedAt");

-- CreateIndex
CREATE INDEX "DriverLocationPoint_recordedAt_idx" ON "DriverLocationPoint" USING BRIN ("recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminPasskey_credentialId_key" ON "AdminPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "AdminPasskey_userId_idx" ON "AdminPasskey"("userId");

-- AddForeignKey
ALTER TABLE "DriverOnlineSession" ADD CONSTRAINT "DriverOnlineSession_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideOffer" ADD CONSTRAINT "RideOffer_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideOffer" ADD CONSTRAINT "RideOffer_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocationPoint" ADD CONSTRAINT "DriverLocationPoint_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminPasskey" ADD CONSTRAINT "AdminPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

