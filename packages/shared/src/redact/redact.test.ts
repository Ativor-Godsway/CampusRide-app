import { describe, expect, it } from "vitest";
import { maskPhone, redactError, redactText, redactValue } from "./redact";

describe("maskPhone", () => {
  it("keeps the last three digits, whatever the spelling", () => {
    for (const phone of ["+233548617146", "233548617146", "0548617146"]) {
      expect(maskPhone(phone)).toBe("+233*****146");
    }
  });
});

/** A made-up token in a JWT's shape, assembled here so secret scanners don't flag the source. */
const FAKE_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJ1c2VySWQiOiJ4In0", "c2lnbmF0dXJlXzEyMw"].join(".");

describe("redactText", () => {
  it.each([
    ["Sent to +233548617146", "Sent to +233*****146"],
    ["Sent to 0548617146.", "Sent to +233*****146."],
    ["phone=233548617146&x=1", "phone=+233*****146&x=1"],
    ["GET /track/9f2c41aa?x=1", "GET /track/[token]?x=1"],
    [`Bearer ${FAKE_JWT}`, "Bearer [jwt]"],
    ["token ExponentPushToken[AbC-123_xyz] failed", "token ExponentPushToken[…] failed"],
    [`refresh ${"a1".repeat(32)} expired`, "refresh [hex] expired"],
    [
      "connect to postgresql://app:not-a-real-password@db.example.com/app failed",
      "connect to postgresql://[credentials]@db.example.com/app failed",
    ],
  ])("%s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("leaves ordinary numbers alone", () => {
    for (const text of [
      "ride 12 took 1760551234567 ms",
      "fare GHS 15.00",
      "port 3000",
      "12345678901234",
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });
});

describe("redactValue", () => {
  it("replaces secret-named fields and scrubs every string, nested", () => {
    expect(
      redactValue({
        authorization: "Bearer x",
        refreshToken: "r",
        code: "OK",
        otpCode: "123456",
        user: { phone: "0548617146", name: "Ama" },
        list: ["+233548617146", 3],
        missing: null,
        accessToken: undefined,
      }),
    ).toEqual({
      authorization: "[redacted]",
      refreshToken: "[redacted]",
      code: "OK",
      otpCode: "[redacted]",
      user: { phone: "+233*****146", name: "Ama" },
      list: ["+233*****146", 3],
      missing: null,
      accessToken: undefined,
    });
  });

  it("leaves errors and framework objects to their own serializers", () => {
    const err = new Error("x");
    expect((redactValue({ err }) as { err: unknown }).err).toBe(err);
  });
});

describe("redactError", () => {
  it("keeps the type and code, scrubs the message and stack", () => {
    const err = Object.assign(new Error("no user 0548617146"), { code: "P2025" });
    const out = redactError(err) as { type: string; message: string; stack: string; code: string };
    expect(out.type).toBe("Error");
    expect(out.code).toBe("P2025");
    expect(out.message).toBe("no user +233*****146");
    expect(out.stack).not.toContain("0548617146");
  });
});
