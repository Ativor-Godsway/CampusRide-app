-- Sign-up confirmation: "I'm 18 or older and I agree to the Terms and Privacy
-- Policy". Only adds nullable columns, so it is safe to apply before the code
-- that uses them is deployed: the running server simply doesn't read them.
-- Existing accounts stay NULL (not confirmed); the apps ask them once.
ALTER TABLE "User" ADD COLUMN "ageConfirmedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "termsVersion" TEXT;

-- App Store / Google Play review demo accounts (services/reviewDemo) are
-- pre-confirmed, so a reviewer signs in straight to the app. The server also
-- does this whenever it creates or reuses one.
UPDATE "User"
SET "ageConfirmedAt" = CURRENT_TIMESTAMP,
    "termsAcceptedAt" = CURRENT_TIMESTAMP,
    "termsVersion" = '2026-10-18'
WHERE "isReviewDemo" = true AND "termsAcceptedAt" IS NULL;
