import type { OtpResult, OtpService } from "./OtpService";
import { sendMoolreSms, type MoolreSmsConfig } from "../sms/MoolreSmsService";

export type { MoolreSmsConfig };

/**
 * Real OTP delivery via Moolre's SMS (VAS) API.
 *
 * Only instantiated when config.otpProvider === "moolre" and the Moolre VAS
 * key + sender ID are configured (see services/active.ts) — tests and local
 * dev use DummyOtpService instead, so this code path never runs in the
 * automated test suite. Verified via the manual sandbox script
 * (scripts/sendTestOtpMoolre.ts).
 *
 * Delegates the actual HTTP call to sendMoolreSms (services/sms/MoolreSmsService) —
 * the generic Moolre SMS transport shared with USSD ride-transition
 * notifications — supplying only the OTP-specific message template and a
 * distinct ref prefix ("otp") so sends remain traceable in Moolre's dashboard.
 */
export class MoolreOtpService implements OtpService {
  constructor(
    private readonly cfg: MoolreSmsConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async sendOtp(phone: string, code: string): Promise<OtpResult> {
    const message = `Your CampusRide code is ${code}. Valid for 5 minutes. Do not share this code.`;
    return sendMoolreSms(this.cfg, phone, message, { refPrefix: "otp", fetchFn: this.fetchFn });
  }
}
