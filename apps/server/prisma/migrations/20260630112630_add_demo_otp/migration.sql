-- CreateTable
CREATE TABLE "DemoOtp" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoOtp_phone_idx" ON "DemoOtp"("phone");

-- CreateIndex
CREATE INDEX "DemoOtp_createdAt_idx" ON "DemoOtp"("createdAt");

-- CreateIndex
CREATE INDEX "DemoOtp_ip_idx" ON "DemoOtp"("ip");
