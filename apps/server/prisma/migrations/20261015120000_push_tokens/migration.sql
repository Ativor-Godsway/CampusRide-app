-- Expo push tokens, one row per app install (services/push).
--
-- PURELY ADDITIVE: a new table; no existing table or row changes. Safe to
-- apply to production BEFORE the server code that uses it is deployed.
CREATE TABLE "PushToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "app" VARCHAR(10) NOT NULL,
    "platform" VARCHAR(10) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushToken_token_key" ON "PushToken"("token");

CREATE INDEX "PushToken_userId_idx" ON "PushToken"("userId");

ALTER TABLE "PushToken" ADD CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
