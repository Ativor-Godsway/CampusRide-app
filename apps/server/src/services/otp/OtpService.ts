export interface OtpResult {
  success: boolean;
}

export interface OtpService {
  /**
   * Send a one-time password to a phone number. `message`, when given, is
   * the whole text to send (it already contains the code) instead of the
   * provider's usual "Your CampusRide code is ..." wording.
   */
  sendOtp(phone: string, code: string, message?: string): Promise<OtpResult>;
}
