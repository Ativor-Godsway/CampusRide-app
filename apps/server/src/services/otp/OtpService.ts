export interface OtpResult {
  success: boolean;
}

export interface OtpService {
  /** Send a one-time password to a phone number. */
  sendOtp(phone: string, code: string): Promise<OtpResult>;
}
