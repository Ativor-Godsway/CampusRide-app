-- App Store / Google Play review demo: flags marking demo accounts and their
-- rides, so they're kept apart from real people. Only adds columns (default
-- false, so every existing row is a real one) and an index.
ALTER TABLE "User" ADD COLUMN "isReviewDemo" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Ride" ADD COLUMN "isReviewDemo" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Ride_isReviewDemo_idx" ON "Ride"("isReviewDemo");

-- The demo's two simulated people (a driver and a rider no one can sign in
-- as) have placeholder phones "review-demo:driver" / "review-demo:rider",
-- next to the real "+233…" numbers and closed accounts' "deleted:…".
ALTER TABLE "User" DROP CONSTRAINT "User_phone_canonical_check";
ALTER TABLE "User"
  ADD CONSTRAINT "User_phone_canonical_check"
  CHECK (phone LIKE '+233%' OR phone LIKE 'deleted:%' OR phone LIKE 'review-demo:%');
