-- Service hours: when riders can book (Settings -> Service hours in the admin
-- site), and the riders who asked to be told when CampusRide opens. Additive
-- only: two new tables that start empty, one new enum type, and one new
-- value on BroadcastKind. Safe to apply before the code that uses it is
-- deployed: the running server reads none of it. With no settings row the new
-- server uses the defaults (every day 08:00-17:00 Africa/Accra, requests
-- blocked when no driver is online).
CREATE TYPE "ServiceOverrideMode" AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE "ServiceHoursSetting" (
    "id" TEXT NOT NULL DEFAULT 'service',
    "weekly" JSONB NOT NULL,
    "overrideMode" "ServiceOverrideMode",
    "overrideUntil" TIMESTAMP(3),
    "closedMessage" VARCHAR(120),
    "blockWhenNoDrivers" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ServiceHoursSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServiceOpenWaiter" (
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceOpenWaiter_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "ServiceOpenWaiter" ADD CONSTRAINT "ServiceOpenWaiter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "We're open!" to the riders who asked, recorded in the Notifications history.
ALTER TYPE "BroadcastKind" ADD VALUE 'OPENING';
