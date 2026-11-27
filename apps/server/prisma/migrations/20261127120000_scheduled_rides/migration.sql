-- Scheduled Shared rides (2026-11-27). Additive only: new tables, two
-- nullable User columns, and Ride.booking (every existing ride is LIVE).
-- Rules: @rida/shared rides/scheduled.ts; server: services/scheduled.

-- CreateEnum
CREATE TYPE "RideBooking" AS ENUM ('LIVE', 'SCHEDULED', 'SCHEDULED_TO_LIVE');

-- CreateEnum
CREATE TYPE "ScheduledCarStatus" AS ENUM ('OPEN', 'ACCEPTED', 'STARTED', 'LIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScheduledBookingStatus" AS ENUM ('BOOKED', 'STARTED', 'LIVE', 'CANCELLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "scheduleBlockedAt" TIMESTAMP(3),
ADD COLUMN     "scheduleBlockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "booking" "RideBooking" NOT NULL DEFAULT 'LIVE',
ADD COLUMN     "scheduledCarId" TEXT;

-- CreateTable
CREATE TABLE "ScheduledCar" (
    "id" TEXT NOT NULL,
    "arriveBy" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledCarStatus" NOT NULL DEFAULT 'OPEN',
    "driverId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedVia" VARCHAR(10),
    "offeredAt" TIMESTAMP(3),
    "leaveBy" TIMESTAMP(3),
    "driverRemindedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "rideId" TEXT,
    "liveAt" TIMESTAMP(3),
    "liveReason" VARCHAR(20),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledCar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledBooking" (
    "id" TEXT NOT NULL,
    "carId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "arriveBy" TIMESTAMP(3) NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 1,
    "lockedFare" INTEGER NOT NULL,
    "status" "ScheduledBookingStatus" NOT NULL DEFAULT 'BOOKED',
    "pickupZoneId" TEXT NOT NULL,
    "dropoffZoneId" TEXT NOT NULL,
    "pickupLat" DOUBLE PRECISION,
    "pickupLng" DOUBLE PRECISION,
    "pickupLabel" VARCHAR(120),
    "pickupPlaceId" TEXT,
    "dropoffLat" DOUBLE PRECISION,
    "dropoffLng" DOUBLE PRECISION,
    "dropoffLabel" VARCHAR(120),
    "dropoffPlaceId" TEXT,
    "pickupNote" VARCHAR(140),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "lateCancel" BOOLEAN NOT NULL DEFAULT false,
    "remindedAt" TIMESTAMP(3),
    "comingAt" TIMESTAMP(3),
    "rideId" TEXT,
    "ridePassengerId" TEXT,
    "liveAt" TIMESTAMP(3),
    "noShowAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleStrike" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleStrike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledRideEvent" (
    "id" TEXT NOT NULL,
    "carId" TEXT NOT NULL,
    "bookingId" TEXT,
    "kind" VARCHAR(24) NOT NULL,
    "detail" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledRideEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleSetting" (
    "id" TEXT NOT NULL DEFAULT 'schedule',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "introEnabled" BOOLEAN NOT NULL DEFAULT true,
    "slotMinutes" INTEGER NOT NULL DEFAULT 10,
    "bookingCutoffMinutes" INTEGER NOT NULL DEFAULT 20,
    "carSeats" INTEGER NOT NULL DEFAULT 4,
    "groupRadiusMeters" INTEGER NOT NULL DEFAULT 600,
    "offerNowSeats" INTEGER NOT NULL DEFAULT 3,
    "offerLaterSeats" INTEGER NOT NULL DEFAULT 2,
    "offerLaterMinutes" INTEGER NOT NULL DEFAULT 30,
    "soloLiveMinutes" INTEGER NOT NULL DEFAULT 20,
    "noDriverMinutes" INTEGER NOT NULL DEFAULT 25,
    "driverReminderMinutes" INTEGER NOT NULL DEFAULT 10,
    "riderReminderMinutes" INTEGER NOT NULL DEFAULT 10,
    "driverGapMinutes" INTEGER NOT NULL DEFAULT 25,
    "freeCancelMinutes" INTEGER NOT NULL DEFAULT 30,
    "strikesToBlock" INTEGER NOT NULL DEFAULT 2,
    "blockDays" INTEGER NOT NULL DEFAULT 7,
    "strikeWindowDays" INTEGER NOT NULL DEFAULT 30,
    "pickupMinutesPerStop" INTEGER NOT NULL DEFAULT 3,
    "leaveBufferMinutes" INTEGER NOT NULL DEFAULT 5,
    "pickupWindowMinutes" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ScheduleSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledCar_rideId_key" ON "ScheduledCar"("rideId");

-- CreateIndex
CREATE INDEX "ScheduledCar_arriveBy_idx" ON "ScheduledCar"("arriveBy");

-- CreateIndex
CREATE INDEX "ScheduledCar_status_arriveBy_idx" ON "ScheduledCar"("status", "arriveBy");

-- CreateIndex
CREATE INDEX "ScheduledCar_driverId_idx" ON "ScheduledCar"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledBooking_ridePassengerId_key" ON "ScheduledBooking"("ridePassengerId");

-- CreateIndex
CREATE INDEX "ScheduledBooking_carId_idx" ON "ScheduledBooking"("carId");

-- CreateIndex
CREATE INDEX "ScheduledBooking_riderId_status_idx" ON "ScheduledBooking"("riderId", "status");

-- CreateIndex
CREATE INDEX "ScheduledBooking_arriveBy_idx" ON "ScheduledBooking"("arriveBy");

-- CreateIndex
CREATE INDEX "ScheduledBooking_rideId_idx" ON "ScheduledBooking"("rideId");

-- CreateIndex
CREATE INDEX "ScheduleStrike_riderId_createdAt_idx" ON "ScheduleStrike"("riderId", "createdAt");

-- CreateIndex
CREATE INDEX "ScheduleStrike_createdAt_idx" ON "ScheduleStrike"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleStrike_bookingId_kind_key" ON "ScheduleStrike"("bookingId", "kind");

-- CreateIndex
CREATE INDEX "ScheduledRideEvent_createdAt_idx" ON "ScheduledRideEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ScheduledRideEvent_carId_idx" ON "ScheduledRideEvent"("carId");

-- CreateIndex
CREATE INDEX "Ride_scheduledCarId_idx" ON "Ride"("scheduledCarId");

-- AddForeignKey
ALTER TABLE "ScheduledCar" ADD CONSTRAINT "ScheduledCar_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledBooking" ADD CONSTRAINT "ScheduledBooking_carId_fkey" FOREIGN KEY ("carId") REFERENCES "ScheduledCar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledBooking" ADD CONSTRAINT "ScheduledBooking_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A scheduled booking is 1 to 3 seats (a Shared booking).
ALTER TABLE "ScheduledBooking" ADD CONSTRAINT "ScheduledBooking_seats_check" CHECK ("seats" BETWEEN 1 AND 3);
