import type { OtpResult, OtpService } from "./OtpService";
import { logger } from "../../lib/logger";

/**
 * No-op OTP "delivery" for local dev and the automated test suite.
 *
 * SECURITY: this service must never run in production — OTP codes are stored
 * only as SHA-256 hashes, so the plaintext exists nowhere but here, and
 * printing it would put live login credentials in the server logs. The boot
 * guard in services/active.ts (assertOtpServiceAllowedInProduction) refuses
 * to start the server if this implementation is selected while
 * NODE_ENV=production.
 *
 * Because of that guard, the plaintext code below can only ever be printed on
 * a developer's machine. It is still withheld outside NODE_ENV=development,
 * so a staging/CI box that somehow selects this provider stays quiet.
 */
export class DummyOtpService implements OtpService {
  async sendOtp(phone: string, code: string): Promise<OtpResult> {
    if (process.env.NODE_ENV === "development") {
      // Dev convenience only: codes are hashed at rest, so without this there
      // is no way to complete a login locally.
      logger.info("DummyOtpService: OTP issued (dev only, code shown)", { phone, code });
    } else {
      logger.info("DummyOtpService: OTP issued — code withheld", {
        phone,
        nodeEnv: process.env.NODE_ENV ?? "unset",
      });
    }
    return { success: true };
  }
}
