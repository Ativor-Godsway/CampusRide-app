/**
 * Manual, one-off script to verify real Moolre SMS (VAS) integration. NOT
 * run by the test suite or CI — tests always use DummyOtpService (see
 * services/otp/DummyOtpService.ts and services/active.ts).
 *
 * Usage (requires MOOLRE_ENABLED=true, MOOLRE_BASE_URL, MOOLRE_API_USER,
 * MOOLRE_VAS_KEY, MOOLRE_SMS_SENDER_ID in .env, plus a real phone number):
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/sendTestOtpMoolre.ts +233XXXXXXXXX
 *
 * DIAGNOSTIC MODE: calls the Moolre SMS endpoint directly here (replicating
 * the exact headers/body services/sms/MoolreSmsService.ts builds) instead of
 * going through sendMoolreSms/MoolreOtpService, so the full raw response
 * (status code, response.ok, parsed body) can be printed. This is throwaway —
 * the production sendMoolreSms/MoolreOtpService code is untouched and still
 * only ever returns a boolean.
 *
 * IMPORTANT: MOOLRE_SMS_SENDER_ID must be a sender ID that has already been
 * registered AND approved with Moolre — this has lead time, so kick off
 * sender-ID approval with Moolre early if you haven't already (same as the
 * mNotify sender ID in Phase 3).
 */
import { config } from "../config";

const SMS_SEND_PATH = "/open/sms/send";
const TYPE_SMS = 1;

/** Moolre SMS expects recipients without a leading "+" (e.g. "233XXXXXXXXX"). */
function toMoolreRecipient(phone: string): string {
  return phone.startsWith("+") ? phone.slice(1) : phone;
}

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

  console.log("--- Diagnostic config (no secret values) ---");
  console.log("MOOLRE_BASE_URL:", config.moolre.baseUrl, config.moolre.baseUrl.includes("sandbox") ? "(sandbox)" : "(LIVE)");
  console.log("MOOLRE_API_USER present:", config.moolre.apiUser.length > 0);
  console.log("MOOLRE_VAS_KEY present:", config.moolre.vasKey.length > 0);
  console.log("MOOLRE_SMS_SENDER_ID:", config.moolre.smsSenderId, "(not secret)");
  console.log("---------------------------------------------");

  const code = "123456"; // fixed test code — not a real OTP, just verifying delivery
  const message = `Your CampusRide code is ${code}. Valid for 5 minutes. Do not share this code.`;
  const recipient = toMoolreRecipient(phone);
  const ref = `otp-diag:${recipient}:${Date.now()}`;

  const body = {
    type: TYPE_SMS,
    senderid: config.moolre.smsSenderId,
    messages: [{ recipient, message, ref }],
  };

  const url = `${config.moolre.baseUrl}${SMS_SEND_PATH}`;
  console.log(`\nSending test OTP SMS to ${phone} via Moolre...`);
  console.log("URL:", url);
  console.log("Body:", JSON.stringify(body, null, 2));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": config.moolre.apiUser,
      "X-API-VASKEY": config.moolre.vasKey,
    },
    body: JSON.stringify(body),
  });

  console.log("\n--- Raw Moolre response ---");
  console.log("HTTP status:", response.status);
  console.log("response.ok:", response.ok);

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    console.error("Failed to parse response body as JSON:", err);
    data = await response.text().catch(() => "<unreadable>");
  }
  console.log("Full parsed body:", JSON.stringify(data, null, 2));
  console.log("----------------------------");
}

main().catch((err) => {
  console.error("Diagnostic script failed:", err);
  process.exit(1);
});
