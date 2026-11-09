-- CreateEnum
CREATE TYPE "DriverCreditKind" AS ENUM ('PAYMENT', 'WAIVER', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PaystackPaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'ABANDONED', 'MISMATCH');

-- CreateEnum
CREATE TYPE "MomoNetwork" AS ENUM ('MTN', 'TELECEL', 'AIRTELTIGO');

-- AlterEnum
ALTER TYPE "CashPaymentMethod" ADD VALUE 'PAYSTACK';

-- AlterTable
ALTER TABLE "DriverCashPayment" ADD COLUMN     "kind" "DriverCreditKind" NOT NULL DEFAULT 'PAYMENT',
ADD COLUMN     "paystackPaymentId" TEXT,
ALTER COLUMN "method" DROP NOT NULL;

-- CreateTable
CREATE TABLE "DriverPaystackPayment" (
    "id" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "reference" VARCHAR(100) NOT NULL,
    "status" "PaystackPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "channel" VARCHAR(20) NOT NULL,
    "owedPesewas" INTEGER NOT NULL,
    "feePesewas" INTEGER NOT NULL,
    "grossPesewas" INTEGER NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "feeCapPesewas" INTEGER,
    "momoNetwork" "MomoNetwork",
    "phoneLast4" VARCHAR(4),
    "paystackStatus" VARCHAR(40),
    "message" VARCHAR(300),
    "checkoutUrl" VARCHAR(500),
    "paystackFeePesewas" INTEGER,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverPaystackPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionSetting" (
    "id" TEXT NOT NULL DEFAULT 'commission',
    "debtLimitPesewas" INTEGER NOT NULL DEFAULT 10000,
    "warningPercent" INTEGER NOT NULL DEFAULT 80,
    "enforcementEnabled" BOOLEAN NOT NULL DEFAULT false,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "feeCapPesewas" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "CommissionSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverPaystackPayment_reference_key" ON "DriverPaystackPayment"("reference");

-- CreateIndex
CREATE INDEX "DriverPaystackPayment_driverUserId_createdAt_idx" ON "DriverPaystackPayment"("driverUserId", "createdAt");

-- CreateIndex
CREATE INDEX "DriverPaystackPayment_status_createdAt_idx" ON "DriverPaystackPayment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DriverCashPayment_paystackPaymentId_key" ON "DriverCashPayment"("paystackPaymentId");

-- AddForeignKey
ALTER TABLE "DriverCashPayment" ADD CONSTRAINT "DriverCashPayment_paystackPaymentId_fkey" FOREIGN KEY ("paystackPaymentId") REFERENCES "DriverPaystackPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverPaystackPayment" ADD CONSTRAINT "DriverPaystackPayment_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

