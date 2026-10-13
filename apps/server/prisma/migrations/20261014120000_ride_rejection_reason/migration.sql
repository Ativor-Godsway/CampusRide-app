-- Why a driver passed on a ride offer: "DECLINED" or "TIMED_OUT" (stats only).
--
-- PURELY ADDITIVE: one NULLABLE column; existing rows stay NULL. Safe to apply
-- to production BEFORE the server code that uses it is deployed.
ALTER TABLE "RideRejection" ADD COLUMN "reason" VARCHAR(20);
