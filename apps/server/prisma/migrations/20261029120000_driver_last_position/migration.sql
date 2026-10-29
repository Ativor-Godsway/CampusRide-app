-- The driver's last reported position (campus-only CampusRide, stage 1).
-- The driver app sends its position when going online and with each zone
-- update; the server checks it against the service area and keeps the last
-- one here (also for the admin live map, later). Only adds nullable columns,
-- so it is safe to apply before the code that uses them is deployed: the
-- running server simply doesn't read them. Existing drivers stay NULL until
-- their app next reports.
ALTER TABLE "Driver" ADD COLUMN "lastLat" DOUBLE PRECISION;
ALTER TABLE "Driver" ADD COLUMN "lastLng" DOUBLE PRECISION;
ALTER TABLE "Driver" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
