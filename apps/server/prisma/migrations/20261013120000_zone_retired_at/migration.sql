-- Zones can be taken out of service without deleting them.
--
-- PURELY ADDITIVE: one NULLABLE column. Every existing zone stays in service
-- (NULL). Safe to apply to production BEFORE the server code that uses it.
-- Which zone is retired is DATA, set by `npm run zones:realign -- --apply`
-- (src/scripts/realignZones.ts), not by this migration.
ALTER TABLE "Zone" ADD COLUMN "retiredAt" TIMESTAMP(3);
