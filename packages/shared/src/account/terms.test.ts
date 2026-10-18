import { describe, expect, it } from "vitest";
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION, needsTermsConfirmation } from "./terms";

describe("needsTermsConfirmation", () => {
  it("asks an account that has never confirmed", () => {
    expect(needsTermsConfirmation({ termsAcceptedAt: null, ageConfirmedAt: null })).toBe(true);
    expect(needsTermsConfirmation({ termsAcceptedAt: "2026-10-18T10:00:00.000Z", ageConfirmedAt: null })).toBe(true);
  });

  it("leaves a confirmed account alone", () => {
    const at = "2026-10-18T10:00:00.000Z";
    expect(needsTermsConfirmation({ termsAcceptedAt: at, ageConfirmedAt: at })).toBe(false);
  });

  it("never locks anyone out when the server doesn't say (an older server)", () => {
    expect(needsTermsConfirmation({})).toBe(false);
  });
});

describe("the terms the apps point to", () => {
  it("is dated like the pages' Last updated (YYYY-MM-DD) and lives on campusride.app", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(TERMS_VERSION))).toBe(false);
    expect(TERMS_URL).toBe("https://campusride.app/terms");
    expect(PRIVACY_URL).toBe("https://campusride.app/privacy");
  });
});
