-- Launch mode: the countdown before the public launch, set in the admin
-- site's Settings (services/launch/launchSettings.ts). Adds one small table
-- that starts empty (no row = OFF: everyone can ride, exactly as today) and
-- one nullable column on User. Safe to apply before the code that uses it is
-- deployed: the running server reads neither, and nobody is blocked until an
-- admin turns the countdown on.
CREATE TYPE "LaunchMode" AS ENUM ('OFF', 'COUNTDOWN', 'LIVE');

CREATE TABLE "LaunchSetting" (
    "id" TEXT NOT NULL DEFAULT 'launch',
    "mode" "LaunchMode" NOT NULL DEFAULT 'OFF',
    "launchAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "LaunchSetting_pkey" PRIMARY KEY ("id")
);

-- When an admin gave this rider early access (null = none).
ALTER TABLE "User" ADD COLUMN "earlyAccessAt" TIMESTAMP(3);
