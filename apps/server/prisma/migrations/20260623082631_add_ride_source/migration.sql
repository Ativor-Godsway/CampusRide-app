-- CreateEnum
CREATE TYPE "RideSource" AS ENUM ('APP', 'USSD');

-- AlterTable
ALTER TABLE "Ride" ADD COLUMN     "source" "RideSource" NOT NULL DEFAULT 'APP';
