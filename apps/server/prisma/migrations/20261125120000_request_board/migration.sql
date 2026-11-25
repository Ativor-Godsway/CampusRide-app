-- Request board + longer search window (2026-11-25). Additive only.

-- How a driver took each request: POPUP, LIST or BOARD (null: older apps).
ALTER TABLE "Ride" ADD COLUMN "acceptedVia" VARCHAR(10);

-- The search window (no row = 7 minutes).
CREATE TABLE "DispatchSetting" (
    "id" TEXT NOT NULL DEFAULT 'dispatch',
    "searchWindowSeconds" INTEGER NOT NULL DEFAULT 420,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DispatchSetting_pkey" PRIMARY KEY ("id")
);
