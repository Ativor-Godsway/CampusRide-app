/**
 * Manual, one-off script to verify real mNotify OTP delivery. NOT run by the
 * test suite or CI — tests always use DummyOtpService.
 *
 * Usage (requires MNOTIFY_ENABLED=true, MNOTIFY_API_KEY, MNOTIFY_SENDER_ID in
 * .env, and a real phone number to receive the SMS):
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/sendTestOtp.ts +233XXXXXXXXX
 */
import { config } from "../config";
import { MnotifyOtpService } from "../services/otp/MnotifyOtpService";

async function main() {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Usage: sendTestOtp.ts <phone>");
    process.exit(1);
  }
  if (!config.mnotify.enabled) {
    console.error("Set MNOTIFY_ENABLED=true (and MNOTIFY_API_KEY) in .env before running this.");
    process.exit(1);
  }

  const service = new MnotifyOtpService(config.mnotify.apiKey, config.mnotify.senderId);
  const result = await service.sendOtp(phone, "123456");
  console.log("Send result:", result);
}

main();
