import type { OtpResult, OtpService } from "./OtpService";

export class DummyOtpService implements OtpService {
  async sendOtp(phone: string, code: string): Promise<OtpResult> {
    console.log(`[DummyOtpService] OTP for ${phone}: ${code}`);
    return { success: true };
  }
}
