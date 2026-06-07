-- AlterEnum
ALTER TYPE "RideCancelReason" ADD VALUE 'MERGED_INTO_ANOTHER_RIDE';

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "mergedIntoRideId" TEXT;

-- CreateIndex
CREATE INDEX "Ride_mergedIntoRideId_idx" ON "Ride"("mergedIntoRideId");

-- AddForeignKey
ALTER TABLE "Ride" ADD CONSTRAINT "Ride_mergedIntoRideId_fkey" FOREIGN KEY ("mergedIntoRideId") REFERENCES "Ride"("id") ON DELETE SET NULL ON UPDATE CASCADE;
