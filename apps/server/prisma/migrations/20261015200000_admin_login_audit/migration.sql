-- Admin sign-in auditing (Stage 3): where each admin login attempt came from.
-- Additive only (two nullable columns and an index), so it is safe to apply
-- while the current server is running.

-- AlterTable
ALTER TABLE "AdminAuditLog" ADD COLUMN "ip" VARCHAR(64),
ADD COLUMN "userAgent" VARCHAR(512);

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_timestamp_idx" ON "AdminAuditLog"("action", "timestamp");
