-- Phase 4: safety (emergency contact + SOS tracking link) and explicit
-- driver rejection.

-- One emergency contact per rider, notified by POST /rides/:id/sos.
-- Nullable: existing riders have none until they set one.
ALTER TABLE "User" ADD COLUMN "emergencyContactName" TEXT;
ALTER TABLE "User" ADD COLUMN "emergencyContactPhone" TEXT;

-- Opaque public token for the SOS tracking link. Minted on the first SOS for
-- a ride and reused, so a link already sent to a contact keeps working.
-- Unique because it is the sole credential for the public /track/:token page.
ALTER TABLE "Ride" ADD COLUMN "trackingToken" TEXT;
CREATE UNIQUE INDEX "Ride_trackingToken_key" ON "Ride"("trackingToken");

-- A driver explicitly declining a broadcast ride, so it can be hidden from
-- that driver without being withdrawn from everyone else.
CREATE TABLE "RideRejection" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RideRejection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RideRejection_rideId_driverUserId_key" ON "RideRejection"("rideId", "driverUserId");
CREATE INDEX "RideRejection_driverUserId_idx" ON "RideRejection"("driverUserId");

ALTER TABLE "RideRejection" ADD CONSTRAINT "RideRejection_rideId_fkey"
    FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RideRejection" ADD CONSTRAINT "RideRejection_driverUserId_fkey"
    FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
