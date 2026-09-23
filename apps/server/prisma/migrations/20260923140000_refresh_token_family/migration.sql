-- Phase 2: refresh-token rotation chains ("families") for reuse detection.
--
-- Added nullable, backfilled so every existing token is its own family root,
-- then made NOT NULL. Existing sessions therefore keep working and each one
-- simply starts a new chain from its current token.
ALTER TABLE "RefreshToken" ADD COLUMN "familyId" TEXT;

UPDATE "RefreshToken" SET "familyId" = "id" WHERE "familyId" IS NULL;

ALTER TABLE "RefreshToken" ALTER COLUMN "familyId" SET NOT NULL;

CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
