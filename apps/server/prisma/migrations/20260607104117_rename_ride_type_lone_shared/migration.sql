-- RideType enum: rename SOLO → LONE, remove FLEX.
-- Safe: no rows exist in the Ride table (no rides are seeded in Phase 0).
-- Prisma's standard pattern for altering an enum in PostgreSQL.

BEGIN;

CREATE TYPE "RideType_new" AS ENUM ('LONE', 'SHARED');

ALTER TABLE "Ride"
  ALTER COLUMN "type" TYPE "RideType_new"
  USING ("type"::text::"RideType_new");

DROP TYPE "RideType";

ALTER TYPE "RideType_new" RENAME TO "RideType";

COMMIT;
