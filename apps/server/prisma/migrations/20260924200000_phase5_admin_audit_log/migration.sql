-- Phase 5: admin audit log. Append-only record of every admin action taken
-- through the admin app (driver approvals/rejections today).
--
-- `actor` and `target` are plain TEXT columns rather than foreign keys: the
-- log has to remain readable after the referenced User row is anonymized by
-- DELETE /me, and a FK would tie its lifetime to the account's.
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "reason" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditLog_actor_idx" ON "AdminAuditLog"("actor");
CREATE INDEX "AdminAuditLog_target_idx" ON "AdminAuditLog"("target");
CREATE INDEX "AdminAuditLog_timestamp_idx" ON "AdminAuditLog"("timestamp");
