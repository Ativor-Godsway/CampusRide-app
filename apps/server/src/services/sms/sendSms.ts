import { config } from "../../config";
import { sendMoolreSms } from "./MoolreSmsService";
import { logger } from "../../lib/logger";

/**
 * Generic SMS send for USSD ride-transition notifications (driver matched,
 * arrived, completed, no-driver nudge). Gated behind the same
 * MOOLRE_SMS_ENABLED + VAS-key/sender-id prerequisites as the OTP provider
 * selection in services/active.ts (the SMS flag, NOT the payments one — see
 * config.ts) — when unmet, logs instead of sending so local dev/tests never
 * hit the network.
 */
export async function sendSms(phone: string, message: string): Promise<{ success: boolean }> {
  const { smsEnabled, baseUrl, apiUser, vasKey, smsSenderId } = config.moolre;

  if (!smsEnabled || !vasKey || !smsSenderId) {
    logger.info("Moolre SMS disabled/not configured — message not sent", { phone, message });
    return { success: false };
  }

  return sendMoolreSms(
    { baseUrl, apiUser, vasKey, senderId: smsSenderId },
    phone,
    message,
    { refPrefix: "ride" },
  );
}
