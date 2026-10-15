-- SOS tracking links, one per rider per ride (was one token per ride on
-- "Ride"."trackingToken", which showed a passenger's emergency contact the
-- details of whoever booked the car). Additive only: the old column stays and
-- is still read for links sent before this, so applying this before the code
-- that uses it changes nothing.

-- CreateTable
CREATE TABLE "TrackingLink" (
    "token" VARCHAR(64) NOT NULL,
    "rideId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingLink_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackingLink_rideId_riderId_key" ON "TrackingLink"("rideId", "riderId");

-- AddForeignKey
ALTER TABLE "TrackingLink" ADD CONSTRAINT "TrackingLink_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingLink" ADD CONSTRAINT "TrackingLink_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
