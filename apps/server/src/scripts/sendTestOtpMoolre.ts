/**
 * Manual, one-off script to verify real Moolre SMS (VAS) integration. NOT
 * run by the test suite or CI — tests always use DummyOtpService (see
 * services/otp/DummyOtpService.ts and services/active.ts).
 *
 * Usage (requires OTP_PROVIDER=moolre, MOOLRE_ENABLED=true,
 * MOOLRE_BASE_URL, MOOLRE_API_USER, MOOLRE_VAS_KEY, MOOLRE_SMS_SENDER_ID in
 * .env, plus a real phone number to test against):
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/sendTestOtpMoolre.ts +233XXXXXXXXX
 *
 * IMPORTANT: MOOLRE_SMS_SENDER_ID must be a sender ID that has already been
 * registered AND approved with Moolre — this has lead time, so kick off
 * sender-ID approval with Moolre early if you haven't already (same as the
 * mNotify sender ID in Phase 3).
 */
import { config } from "../config";
import { MoolreOtpService } from "../services/otp/MoolreOtpService";

async function main() {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Usage: sendTestOtpMoolre.ts <phone>");
    process.exit(1);
  }
  if (!config.moolre.enabled || !config.moolre.vasKey || !config.moolre.smsSenderId) {
    console.error(
      "Set MOOLRE_ENABLED=true, MOOLRE_VAS_KEY, and MOOLRE_SMS_SENDER_ID in .env before running this.",
    );
    process.exit(1);
  }

  const service = new MoolreOtpService({
    baseUrl: config.moolre.baseUrl,
    apiUser: config.moolre.apiUser,
    vasKey: config.moolre.vasKey,
    senderId: config.moolre.smsSenderId,
  });

  const code = "123456"; // fixed test code — not a real OTP, just verifying delivery
  console.log(`Sending test OTP SMS to ${phone} via Moolre (sender: ${config.moolre.smsSenderId})...`);
  const result = await service.sendOtp(phone, code);
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Sandbox script failed:", err);
  process.exit(1);
});
