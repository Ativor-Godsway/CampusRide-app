-- Seats on bookings and the seat price table (2026-11-26). Additive only.

-- How many seats a booking takes (Shared 1-3) or people in it (Ride alone
-- 1-4), @rida/shared rides/seats.ts. Every existing booking is 1 seat.
ALTER TABLE "RidePassenger" ADD COLUMN "seats" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "RidePassenger" ADD CONSTRAINT "RidePassenger_seats_check" CHECK ("seats" BETWEEN 1 AND 4);

-- Prices (Settings -> Prices): Shared by seats in one booking, the far
-- surcharge per seat, Ride alone. No row = GH₵7 / 14 / 18, +GH₵2 a seat, GH₵15.
ALTER TABLE "FarePricingSetting" ADD COLUMN "shared2Pesewas" INTEGER NOT NULL DEFAULT 1400;
ALTER TABLE "FarePricingSetting" ADD COLUMN "shared3Pesewas" INTEGER NOT NULL DEFAULT 1800;
ALTER TABLE "FarePricingSetting" ADD COLUMN "farPerSeatPesewas" INTEGER NOT NULL DEFAULT 200;
ALTER TABLE "FarePricingSetting" ADD COLUMN "lonePesewas" INTEGER NOT NULL DEFAULT 1500;

-- A far price already saved keeps its meaning for a 1-seat booking: the
-- surcharge is what it added to the normal seat.
UPDATE "FarePricingSetting" SET "farPerSeatPesewas" = GREATEST(0, "sharedFarPesewas" - "sharedPesewas");
