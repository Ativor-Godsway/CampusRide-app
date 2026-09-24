import { describe, expect, it } from "vitest";
import { normalizePhone, isValidGhanaPhone, toMsisdn, phoneVariants } from "./phone";

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

describe("toMsisdn", () => {
  it("produces the country-code form Moolre's SMS API expects", () => {
    expect(toMsisdn("+233241235993")).toBe("233241235993");
    expect(toMsisdn("233241235993")).toBe("233241235993");
    // The case that was silently breaking SMS: a locally-formatted number.
    expect(toMsisdn("0548608146")).toBe("233548608146");
  });

  it("returns null for anything that isn't a Ghanaian number", () => {
    expect(toMsisdn("+15551234567")).toBeNull();
    expect(toMsisdn("garbage")).toBeNull();
  });
});

describe("phoneVariants", () => {
  /**
   * User.phone holds a MIX of formats: the auth routes store whatever the
   * user typed, USSD/demo-OTP store the canonical form. A lookup has to try
   * all of them.
   */
  it("returns every equivalent stored form, canonical first", () => {
    expect(phoneVariants("0548608146")).toEqual([
      "+233548608146",
      "0548608146",
      "233548608146",
    ]);
  });

  it("returns the same set whichever equivalent form is passed in", () => {
    const fromLocal = [...phoneVariants("0548608146")].sort();
    const fromCanonical = [...phoneVariants("+233548608146")].sort();
    const fromMsisdn = [...phoneVariants("233548608146")].sort();
    expect(fromCanonical).toEqual(fromLocal);
    expect(fromMsisdn).toEqual(fromLocal);
  });

  it("de-duplicates when the raw input is already one of the forms", () => {
    const variants = phoneVariants("+233548608146");
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("tolerates spaces and dashes the way normalizePhone does", () => {
    expect(phoneVariants("054-860 8146")).toContain("+233548608146");
    expect(phoneVariants("054-860 8146")).toContain("0548608146");
  });

  it("degrades to the raw value for a non-Ghanaian number rather than throwing", () => {
    expect(phoneVariants("+15551234567")).toEqual(["+15551234567"]);
    expect(phoneVariants("   ")).toEqual([]);
  });
});
