-- Stage 6: the active-ride check filters RidePassenger by riderId on every
-- booking and every rider app's poll; without an index it scanned the whole
-- table. Only adds an index: nothing is changed or removed.
CREATE INDEX "RidePassenger_riderId_idx" ON "RidePassenger"("riderId");
