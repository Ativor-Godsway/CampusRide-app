/**
 * The staging server (lib/stagingMode.ts, STAGING.md). Pins:
 *   1. CAMPUSRIDE_ENV=staging is refused unless BOTH database URLs are the
 *      staging branch — the production endpoint never, whatever else is set;
 *   2. only then do the test numbers (+233 99 …) get the fixed code, and
 *      only those; every other number keeps a random code;
 *   3. staging relaxes exactly: no SMS provider, a Paystack TEST key,
 *      localhost admin origins — and refuses a live Paystack key, Moolre
 *      payments or SMS, and the review demo;
 *   4. without the flag, nothing changes (production checks as before).
 */
import { describe, expect, it } from "vitest";
import { STAGING_TEST_PHONE, isStagingServer, stagingOtpCodeFor, stagingProblems } from "./stagingMode";
import { checkProductionEnv } from "./productionEnv";
import { assertOtpServiceAllowedInProduction } from "../services/active";
import { DummyOtpService } from "../services/otp/DummyOtpService";
import { assertStagingDatabase } from "../db/stagingGuard";

const STRONG_SECRET = "9f2c1a7b4e8d0c3a5b6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4";
const STAGING_POOLED = "postgresql://u:pw-value@ep-divine-unit-ba9dcaud-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const STAGING_DIRECT = "postgresql://u:pw-value@ep-divine-unit-ba9dcaud.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const PROD_POOLED = "postgresql://u:pw-value@ep-empty-violet-bay5yr3y-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";

/** What the staging Render service is given (STAGING.md). */
const STAGING = {
  NODE_ENV: "production",
  CAMPUSRIDE_ENV: "staging",
  DATABASE_URL: STAGING_POOLED,
  DIRECT_URL: STAGING_DIRECT,
  JWT_SECRET: STRONG_SECRET,
  PUBLIC_BASE_URL: "https://campusride-staging-api.onrender.com",
  CORS_ALLOWED_ORIGINS: "http://localhost:5173",
  ADMIN_PHONE_ALLOWLIST: "+233990000021",
  SUPPORT_CONTACT_PHONE: "+233990000021",
  STAGING_TEST_OTP: "482913",
  CLOUDINARY_URL: "cloudinary://1234:abcd@campusride",
  SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
  PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_000000000000000",
};

describe("staging mode", () => {
  it("a complete staging configuration passes the production checks", () => {
    expect(isStagingServer(STAGING)).toBe(true);
    expect(stagingProblems(STAGING)).toEqual([]);
    expect(checkProductionEnv(STAGING).errors).toEqual([]);
  });

  it("refuses the production database, whichever URL points at it", () => {
    for (const env of [
      { ...STAGING, DATABASE_URL: PROD_POOLED },
      { ...STAGING, DIRECT_URL: PROD_POOLED },
      { ...STAGING, DATABASE_URL: "postgresql://u:p@ep-some-other-branch.neon.tech/db" },
      { ...STAGING, DATABASE_URL: undefined },
    ]) {
      expect(stagingProblems(env).length).toBeGreaterThan(0);
      expect(checkProductionEnv(env).errors.some((e) => /staging database/.test(e))).toBe(true);
      expect(stagingOtpCodeFor("+233990000001", env)).toBeNull();
    }
    expect(() => assertStagingDatabase(PROD_POOLED, "test")).toThrow(/PRODUCTION/);
    expect(() => assertStagingDatabase(STAGING_DIRECT, "test")).not.toThrow();
  });

  it("the fixed code is for the test numbers only (+233 99 …)", () => {
    expect(stagingOtpCodeFor("+233990000001", STAGING)).toBe("482913");
    expect(stagingOtpCodeFor("+233991234567", STAGING)).toBe("482913");
    for (const real of ["+233241234567", "+233548617924", "+233099000001", "+23399000000"]) {
      expect(STAGING_TEST_PHONE.test(real)).toBe(false);
      expect(stagingOtpCodeFor(real, STAGING)).toBeNull();
    }
  });

  it("refuses a live Paystack key, Moolre payments or SMS, the review demo, a bad code", () => {
    const problem = (over: Record<string, string>) => stagingProblems({ ...STAGING, ...over });
    expect(problem({ PAYSTACK_SECRET_KEY: "sk_live_x" })).toHaveLength(1);
    expect(problem({ MOOLRE_PAYMENTS_ENABLED: "true" })).toHaveLength(1);
    expect(problem({ MOOLRE_SMS_ENABLED: "true" })).toHaveLength(1);
    expect(problem({ MNOTIFY_ENABLED: "true" })).toHaveLength(1);
    expect(problem({ REVIEW_DEMO_ENABLED: "true" })).toHaveLength(1);
    expect(problem({ STAGING_TEST_OTP: "12345" })).toHaveLength(1);
    expect(checkProductionEnv({ ...STAGING, OTP_PROVIDER: "moolre" }).errors).toContain(
      "OTP_PROVIDER must be unset on staging (no login code is ever texted)",
    );
  });

  it("no SMS provider is fine on staging, and only there", () => {
    expect(() => assertOtpServiceAllowedInProduction(new DummyOtpService(), "production", STAGING)).not.toThrow();
    expect(() => assertOtpServiceAllowedInProduction(new DummyOtpService(), "production", { ...STAGING, DATABASE_URL: PROD_POOLED })).toThrow();
    expect(() => assertOtpServiceAllowedInProduction(new DummyOtpService(), "production", {})).toThrow();
  });

  it("without the flag nothing changes: no fixed code, a test key and localhost origins are still refused", () => {
    const notStaging = { ...STAGING, CAMPUSRIDE_ENV: undefined };
    expect(isStagingServer(notStaging)).toBe(false);
    expect(stagingProblems(notStaging)).toEqual([]);
    expect(stagingOtpCodeFor("+233990000001", notStaging)).toBeNull();
    const errors = checkProductionEnv(notStaging).errors.join("\n");
    expect(errors).toMatch(/OTP_PROVIDER must be moolre or mnotify/);
    expect(errors).toMatch(/Paystack TEST key/);
    expect(errors).toMatch(/only https:\/\/ origins/);
  });
});
