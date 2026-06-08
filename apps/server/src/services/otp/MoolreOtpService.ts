import type { OtpResult, OtpService } from "./OtpService";

const SMS_SEND_PATH = "/open/sms/send";
const TYPE_SMS = 1;
const SMS_STATUS_SUCCESS = 1;

export interface MoolreSmsConfig {
  /** `https://sandbox.moolre.com` for sandbox, `https://api.moolre.com` for live. Same base URL as payments. */
  baseUrl: string;
  /** X-API-USER header — username, sent on all calls. */
  apiUser: string;
  /** X-API-VASKEY header — SMS (VAS) calls only. A separate key from the payment keys. Never log. */
  vasKey: string;
  /** Pre-registered, approved Moolre sender ID. */
  senderId: string;
}

interface MoolreSmsResponseShape {
  status?: number | string;
  [key: string]: unknown;
}

/**
 * Real OTP delivery via Moolre's SMS (VAS) API.
 *
 * Only instantiated when config.otpProvider === "moolre" and the Moolre VAS
 * key + sender ID are configured (see services/active.ts) — tests and local
 * dev use DummyOtpService instead, so this code path never runs in the
 * automated test suite. Verified via the manual sandbox script
 * (scripts/sendTestOtpMoolre.ts).
 */
export class MoolreOtpService implements OtpService {
  constructor(
    private readonly cfg: MoolreSmsConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async sendOtp(phone: string, code: string): Promise<OtpResult> {
    const recipient = toMoolreRecipient(phone);
    const message = `Your CampusRide code is ${code}. Valid for 5 minutes. Do not share this code.`;
    const ref = `otp:${recipient}:${Date.now()}`;

    const body = {
      type: TYPE_SMS,
      senderid: this.cfg.senderId,
      messages: [{ recipient, message, ref }],
    };

    const response = await this.fetchFn(`${this.cfg.baseUrl}${SMS_SEND_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-USER": this.cfg.apiUser,
        "X-API-VASKEY": this.cfg.vasKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return { success: false };
    }

    const data = (await response.json()) as MoolreSmsResponseShape;
    return { success: data.status === SMS_STATUS_SUCCESS || data.status === String(SMS_STATUS_SUCCESS) };
  }
}

/** Moolre SMS expects recipients without a leading "+" (e.g. "233XXXXXXXXX"). */
function toMoolreRecipient(phone: string): string {
  return phone.startsWith("+") ? phone.slice(1) : phone;
}
