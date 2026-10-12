-- Exact pickup/drop-off pins, campus places, and a cache of point-to-point routes.
--
-- PURELY ADDITIVE: nullable columns on "Ride" and "RidePassenger", one new
-- enum and two new tables. No existing row or column changes, so this is safe
-- to apply to production BEFORE the server code that uses it is deployed.
-- (Prisma selects every column, so the new code must never run against a
-- database without them.)
--
-- Rides keep pickupZoneId/dropoffZoneId (NOT NULL, unchanged): the server
-- derives them from the pins, and old app builds keep sending zones alone.

-- CreateEnum
CREATE TYPE "PlaceCategory" AS ENUM ('HALL', 'HOSTEL', 'FACULTY', 'GATE', 'FOOD', 'LANDMARK', 'OTHER');

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "dropoffLabel" VARCHAR(120),
ADD COLUMN     "dropoffLat" DOUBLE PRECISION,
ADD COLUMN     "dropoffLng" DOUBLE PRECISION,
ADD COLUMN     "dropoffPlaceId" TEXT,
ADD COLUMN     "pickupLabel" VARCHAR(120),
ADD COLUMN     "pickupLat" DOUBLE PRECISION,
ADD COLUMN     "pickupLng" DOUBLE PRECISION,
ADD COLUMN     "pickupNote" VARCHAR(140),
ADD COLUMN     "pickupPlaceId" TEXT;

-- AlterTable
ALTER TABLE "RidePassenger" ADD COLUMN     "dropoffLabel" VARCHAR(120),
ADD COLUMN     "dropoffLat" DOUBLE PRECISION,
ADD COLUMN     "dropoffLng" DOUBLE PRECISION,
ADD COLUMN     "dropoffPlaceId" TEXT,
ADD COLUMN     "pickupLabel" VARCHAR(120),
ADD COLUMN     "pickupLat" DOUBLE PRECISION,
ADD COLUMN     "pickupLng" DOUBLE PRECISION,
ADD COLUMN     "pickupNote" VARCHAR(140),
ADD COLUMN     "pickupPlaceId" TEXT;

-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "category" "PlaceCategory" NOT NULL DEFAULT 'OTHER',
    "zoneId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointRoute" (
    "key" TEXT NOT NULL,
    "polyline" TEXT NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "legDistances" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "legDurations" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointRoute_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Place_source_key" ON "Place"("source");

-- CreateIndex
CREATE INDEX "Place_isActive_idx" ON "Place"("isActive");

-- AddForeignKey
ALTER TABLE "Place" ADD CONSTRAINT "Place_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

