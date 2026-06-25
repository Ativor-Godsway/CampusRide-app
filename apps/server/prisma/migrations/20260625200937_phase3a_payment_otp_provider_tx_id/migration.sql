-- AlterEnum
ALTER TYPE "PaymentRecordStatus" ADD VALUE 'AWAITING_OTP';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "providerTxId" TEXT;
