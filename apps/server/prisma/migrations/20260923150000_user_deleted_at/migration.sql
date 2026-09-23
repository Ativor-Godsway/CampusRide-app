-- Phase 2: in-app account deletion (DELETE /me).
--
-- Accounts are anonymized in place, never row-deleted: Ride.riderId is
-- ON DELETE RESTRICT and the ride/commission history is financial record.
-- deletedAt marks the account closed so it cannot be logged into again.
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
