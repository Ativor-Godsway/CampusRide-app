import { describe, expect, it } from "vitest";
import { checkDeployEnv, checkProductionEnv, jwtSecretProblem, secretBytes } from "./productionEnv";

const STRONG_SECRET = "9f2c1a7b4e8d0c3a5b6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4"; // 32 bytes of hex

/** Everything a production server needs, set correctly. */
const GOOD = {
  DATABASE_URL:
    "postgresql://neondb_owner:pw-value-aaaa@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&pgbouncer=true",
  DIRECT_URL:
    "postgresql://neondb_owner:pw-value-aaaa@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require",
  JWT_SECRET: STRONG_SECRET,
  PUBLIC_BASE_URL: "https://api.campusride.app",
  CORS_ALLOWED_ORIGINS: "https://campusride-admin.onrender.com",
  ADMIN_PHONE_ALLOWLIST: "0241234567",
  SUPPORT_CONTACT_PHONE: "0201112222",
  OTP_PROVIDER: "moolre",
  MOOLRE_SMS_ENABLED: "true",
  MOOLRE_VAS_KEY: "vas-key-value",
  MOOLRE_SMS_SENDER_ID: "CampusRide",
  CLOUDINARY_URL: "cloudinary://1234:abcd@campusride",
  SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
};

const without = (name: keyof typeof GOOD) => {
  const env: Record<string, string | undefined> = { ...GOOD };
  delete env[name];
  return env;
};

describe("checkProductionEnv", () => {
  it("passes a complete production configuration", () => {
    expect(checkProductionEnv(GOOD)).toEqual({ errors: [], warnings: [] });
  });

  it("names every required variable that is missing", () => {
    for (const name of [
      "DATABASE_URL",
      "DIRECT_URL",
      "JWT_SECRET",
      "PUBLIC_BASE_URL",
      "CORS_ALLOWED_ORIGINS",
      "ADMIN_PHONE_ALLOWLIST",
      "SUPPORT_CONTACT_PHONE",
      "MOOLRE_VAS_KEY",
      "MOOLRE_SMS_SENDER_ID",
    ] as const) {
      const { errors } = checkProductionEnv(without(name));
      expect(
        errors.some((e) => e.includes(name)),
        name,
      ).toBe(true);
    }
  });

  it("refuses dummy login codes, bad URLs and a mistyped admin number", () => {
    const errors = (overrides: Record<string, string>) =>
      checkProductionEnv({ ...GOOD, ...overrides }).errors;
    expect(errors({ OTP_PROVIDER: "dummy" })).toEqual([expect.stringContaining("OTP_PROVIDER")]);
    expect(errors({ PUBLIC_BASE_URL: "http://localhost:3000" })).toEqual([
      expect.stringContaining("PUBLIC_BASE_URL"),
    ]);
    expect(errors({ CORS_ALLOWED_ORIGINS: "http://campusride-admin.onrender.com" })).toEqual([
      expect.stringContaining("https://"),
    ]);
    expect(errors({ ADMIN_PHONE_ALLOWLIST: "0241234567, 02412" })).toEqual([
      expect.stringContaining("1 entry"),
    ]);
    expect(errors({ DATABASE_URL: "postgresql://u:p@localhost:5432/db" })).toEqual([
      expect.stringContaining("localhost"),
    ]);
  });

  it("requires every payment key once payments are on", () => {
    const { errors, warnings } = checkProductionEnv({ ...GOOD, MOOLRE_PAYMENTS_ENABLED: "true" });
    for (const name of [
      "MOOLRE_API_USER",
      "MOOLRE_PUBLIC_KEY",
      "MOOLRE_PRIVATE_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
      "MOOLRE_WEBHOOK_SECRET",
    ]) {
      expect(
        errors.some((e) => e.includes(name)),
        name,
      ).toBe(true);
    }
    expect(warnings).toEqual([expect.stringContaining("sandbox")]);
  });

  it("refuses development switches, and warns about TRUST_PROXY and missing Cloudinary", () => {
    const { errors } = checkProductionEnv({
      ...GOOD,
      ENABLE_MOCK_DRIVER: "true",
      ENABLE_USSD: "true",
      TRUST_PROXY: "true",
    });
    expect(errors).toHaveLength(3);
    const { warnings } = checkProductionEnv({ ...without("CLOUDINARY_URL"), TRUST_PROXY: "1" });
    expect(warnings).toHaveLength(2);
  });

  it("warns, without refusing, when Sentry isn't set up", () => {
    const { errors, warnings } = checkProductionEnv(without("SENTRY_DSN"));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("SENTRY_DSN is not set")]);
  });

  it("never repeats a value in what it says", () => {
    const env = {
      ...GOOD,
      JWT_SECRET: "short-but-secret-ish",
      DATABASE_URL: "mysql://root:hunter2@db/x",
    };
    const said = JSON.stringify(checkProductionEnv(env));
    expect(said).not.toContain("hunter2");
    expect(said).not.toContain("short-but-secret-ish");
  });
});

describe("JWT_SECRET strength", () => {
  it("accepts 32 random bytes as hex or base64", () => {
    expect(jwtSecretProblem(STRONG_SECRET)).toBeNull();
    expect(jwtSecretProblem("q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c=")).toBeNull(); // 44 base64 chars
    expect(secretBytes(STRONG_SECRET)).toBe(32);
  });

  it("refuses missing, short, placeholder and repetitive secrets", () => {
    expect(jwtSecretProblem(undefined)).toContain("not set");
    expect(jwtSecretProblem("9f2c1a7b4e8d0c3a5b6e7f8091a2b3c4")).toContain("too short"); // 16 bytes
    expect(jwtSecretProblem("replace-with-a-long-random-secret-for-production-use")).toContain(
      "placeholder",
    );
    expect(jwtSecretProblem("a".repeat(80))).toContain("repetitive");
  });
});

describe("checkDeployEnv", () => {
  it("refuses a Render server that isn't running as production", () => {
    expect(checkDeployEnv({ RENDER: "true", NODE_ENV: "development" })).toContain("NODE_ENV");
    expect(checkDeployEnv({ RENDER: "true", NODE_ENV: "production" })).toBeNull();
    expect(checkDeployEnv({ NODE_ENV: "development" })).toBeNull();
    expect(
      checkDeployEnv({
        RENDER: "true",
        NODE_ENV: "staging",
        ALLOW_NON_PRODUCTION_ON_RENDER: "true",
      }),
    ).toBeNull();
  });
});
