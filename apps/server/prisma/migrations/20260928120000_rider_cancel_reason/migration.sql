-- Rider-supplied cancellation reason and note, from the app's cancel sheet.
--
-- PURELY ADDITIVE: one new enum type and two NULLABLE columns. No existing
-- row or column is touched, so this is safe to apply to production BEFORE
-- the server code that reads these columns is deployed (Prisma selects every
-- column, so the new code must never run against a database without them).
-- The currently deployed server ignores the new columns.

CREATE TYPE "RiderCancelReason" AS ENUM (
    'WAITING_TOO_LONG',
    'CHANGED_PLANS',
    'WRONG_ADDRESS',
    'FOUND_ANOTHER_RIDE',
    'PRICE',
    'DRIVER_TOO_SLOW',
    'DRIVER_ASKED_TO_CANCEL',
    'OTHER'
);

ALTER TABLE "Ride" ADD COLUMN "riderCancelReason" "RiderCancelReason";
ALTER TABLE "Ride" ADD COLUMN "riderCancelNote" VARCHAR(200);
