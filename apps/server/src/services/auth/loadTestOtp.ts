import { OTP } from "./constants";

/**
 * The fixed login code for the local load test (docs/runbooks/load-test.md),
 * so simulated riders can sign in through the real login routes. Null — real
 * random codes — unless ALL of these hold:
 *
 * - NODE_ENV is "test" (Render refuses to run anything but "production":
 *   lib/productionEnv.ts#checkDeployEnv);
 * - LOAD_TEST_OTP_CODE is exactly a 6-digit code;
 * - the database is on this machine (localhost / 127.0.0.1 / ::1).
 *
 * A production server also refuses to start if LOAD_TEST_OTP_CODE is set at
 * all (checkProductionEnv), and the server announces at startup when the
 * fixed code is in use.
 */
export function loadTestOtpCode(env: NodeJS.ProcessEnv = process.env): string | null {
  const code = env.LOAD_TEST_OTP_CODE?.trim();
  if (env.NODE_ENV !== "test" || !code) return null;
  if (!new RegExp(`^\\d{${OTP.OTP_LENGTH}}$`).test(code)) return null;
  let host: string;
  try {
    host = new URL(env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  return ["localhost", "127.0.0.1", "::1"].includes(host) ? code : null;
}
