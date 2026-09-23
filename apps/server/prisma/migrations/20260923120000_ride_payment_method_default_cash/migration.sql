-- Phase 1 (cash-only lockdown): flip Ride.paymentMethod's default from MOMO to
-- CASH. Digital payment is gated off (MOOLRE_ENABLED=false), so a row created
-- without an explicit paymentMethod must not land as MOMO — such a ride cannot
-- be settled and would be skipped by the CASH CommissionLedger write.
--
-- Default-only change: existing rows are deliberately left untouched (their
-- recorded payment method is historical fact, not a setting to rewrite).
ALTER TABLE "Ride" ALTER COLUMN "paymentMethod" SET DEFAULT 'CASH';
