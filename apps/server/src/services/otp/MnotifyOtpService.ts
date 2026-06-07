import type { OtpResult, OtpService } from "./OtpService";

const MNOTIFY_QUICK_SMS_URL = "https://api.mnotify.com/api/sms/quick";

/**
 * Real OTP delivery via mNotify's Quick SMS API (v1), using
 * `sms_type: "otp"` so mNotify applies its OTP-specific delivery handling.
 *
 * Only instantiated when `config.mnotify.enabled` is true (see
 * services/active.ts) — tests and local dev use DummyOtpService instead, so
 * this code path never runs in the test suite.
 */
export class MnotifyOtpService implements OtpService {
  constructor(
    private readonly apiKey: string,
    private readonly senderId: string,
  ) {}

  async sendOtp(phone: string, code: string): Promise<OtpResult> {
    const body = {
      recipient: [phone],
      sender: this.senderId,
      message: `Your CampusRide verification code is ${code}. It expires in 5 minutes.`,
      is_schedule: false,
      schedule_date: "",
      sms_type: "otp",
    };

    const response = await fetch(`${MNOTIFY_QUICK_SMS_URL}?key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return { success: false };
    }

    const data = (await response.json()) as { status?: string };
    return { success: data.status === "success" };
  }
}
