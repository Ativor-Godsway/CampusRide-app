import { describe, expect, it } from "vitest";
import { normalizePhone, isValidGhanaPhone } from "./phone";

describe("normalizePhone", () => {
  it("passes through an already-canonical +233 number", () => {
    expect(normalizePhone("+233241235993")).toBe("+233241235993");
  });

  it("adds the + to a bare 233 number (Moolre's USSD msisdn format)", () => {
    expect(normalizePhone("233241235993")).toBe("+233241235993");
  });

  it("converts a local 0-prefixed number", () => {
    expect(normalizePhone("0241235993")).toBe("+233241235993");
  });

  it("strips spaces and dashes before matching", () => {
    expect(normalizePhone("+233 24 123 5993")).toBe("+233241235993");
    expect(normalizePhone("024-123-5993")).toBe("+233241235993");
  });

  it("returns null for the wrong digit count", () => {
    expect(normalizePhone("23324123599")).toBeNull();
    expect(normalizePhone("02412359")).toBeNull();
  });

  it("returns null for non-Ghanaian / garbage input", () => {
    expect(normalizePhone("not a phone")).toBeNull();
    expect(normalizePhone("+15551234567")).toBeNull();
  });
});

describe("isValidGhanaPhone", () => {
  it("matches normalizePhone's success/failure", () => {
    expect(isValidGhanaPhone("233241235993")).toBe(true);
    expect(isValidGhanaPhone("garbage")).toBe(false);
  });
});
