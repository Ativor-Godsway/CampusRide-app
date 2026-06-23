import { config } from "../../config";
import { sendMoolreSms } from "./MoolreSmsService";

/**
 * Generic SMS send for USSD ride-transition notifications (driver matched,
 * arrived, completed, no-driver nudge). Gated behind the same
 * MOOLRE_ENABLED + VAS-key/sender-id prerequisites as the OTP provider
 * selection in services/active.ts — when unmet, logs instead of sending so
 * local dev/tests never hit the network.
 */
export async function sendSms(phone: string, message: string): Promise<{ success: boolean }> {
  const { enabled, baseUrl, apiUser, vasKey, smsSenderId } = config.moolre;

  if (!enabled || !vasKey || !smsSenderId) {
    console.log(`[sendSms] Moolre SMS disabled/not configured — would have sent to ${phone}: ${message}`);
    return { success: false };
  }

  return sendMoolreSms(
    { baseUrl, apiUser, vasKey, senderId: smsSenderId },
    phone,
    message,
    { refPrefix: "ride" },
  );
}
