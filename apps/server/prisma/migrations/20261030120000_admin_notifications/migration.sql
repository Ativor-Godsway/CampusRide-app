-- Admin notifications: the send history of the admin site's Notifications
-- page (and of the one-time launch push), plus the Settings switch for that
-- push. Additive only: one new table that starts empty, two new enum types,
-- and one column with a default (off). Safe to apply before the code that
-- uses it is deployed: the running server reads none of it.
CREATE TYPE "BroadcastKind" AS ENUM ('RIDERS', 'DRIVERS', 'EVERYONE', 'PHONE', 'TEST', 'LAUNCH');

CREATE TYPE "BroadcastStatus" AS ENUM ('SENDING', 'SENT', 'FAILED');

CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(40),
    "actor" TEXT NOT NULL,
    "kind" "BroadcastKind" NOT NULL,
    "recipientId" TEXT,
    "maskedPhone" VARCHAR(20),
    "title" VARCHAR(50) NOT NULL,
    "body" VARCHAR(150) NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'SENDING',
    "devices" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- The launch push's once-ever guard ("launch").
CREATE UNIQUE INDEX "Broadcast_key_key" ON "Broadcast"("key");

CREATE INDEX "Broadcast_createdAt_idx" ON "Broadcast"("createdAt");

CREATE INDEX "Broadcast_kind_createdAt_idx" ON "Broadcast"("kind", "createdAt");

-- "Send 'CampusRide is live!' when launch mode turns Live": off unless an admin turns it on.
ALTER TABLE "LaunchSetting" ADD COLUMN "launchPushEnabled" BOOLEAN NOT NULL DEFAULT false;
