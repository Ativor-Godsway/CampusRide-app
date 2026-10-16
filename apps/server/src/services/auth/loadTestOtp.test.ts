import { describe, expect, it } from "vitest";
import { loadTestOtpCode } from "./loadTestOtp";
import { checkProductionEnv } from "../../lib/productionEnv";

const LOCAL = "postgresql://u:p@localhost:5432/rida_load";

describe("the load test's fixed login code", () => {
  it("works only in NODE_ENV=test, with a 6-digit code, against a database on this machine", () => {
    expect(
      loadTestOtpCode({ NODE_ENV: "test", LOAD_TEST_OTP_CODE: "123456", DATABASE_URL: LOCAL }),
    ).toBe("123456");
    expect(
      loadTestOtpCode({
        NODE_ENV: "test",
        LOAD_TEST_OTP_CODE: "123456",
        DATABASE_URL: "postgresql://u:p@[::1]:5432/x",
      }),
    ).toBe("123456");
  });

  it("is off in production and development, whatever is set", () => {
    for (const NODE_ENV of ["production", "development", undefined]) {
      expect(
        loadTestOtpCode({ NODE_ENV, LOAD_TEST_OTP_CODE: "123456", DATABASE_URL: LOCAL }),
      ).toBeNull();
    }
  });

  it("is off against any database that isn't local", () => {
    for (const DATABASE_URL of [
      "postgresql://u:p@ep-x-pooler.neon.tech/neondb",
      "postgresql://u:p@localhost.attacker.com/x",
      "not a url",
      undefined,
    ]) {
      expect(
        loadTestOtpCode({ NODE_ENV: "test", LOAD_TEST_OTP_CODE: "123456", DATABASE_URL }),
      ).toBeNull();
    }
  });

  it("is off without a proper code", () => {
    for (const code of [undefined, "", "12345", "1234567", "abcdef"]) {
      expect(
        loadTestOtpCode({ NODE_ENV: "test", LOAD_TEST_OTP_CODE: code, DATABASE_URL: LOCAL }),
      ).toBeNull();
    }
  });

  it("stops a production server from starting if it is set at all", () => {
    const { errors } = checkProductionEnv({ LOAD_TEST_OTP_CODE: "123456" });
    expect(errors).toContainEqual(expect.stringContaining("LOAD_TEST_OTP_CODE is set"));
  });
});
