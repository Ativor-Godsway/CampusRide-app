import { describe, expect, it } from "vitest";
import {
  compactPhoneInput,
  formatGhanaPhone,
  formatGhanaSubscriber,
  ghanaSubscriberDigits,
  normalizeGhanaPhone,
  removeInvisibleCharacters,
} from "./ghanaPhone";

const CANONICAL = "+233548617924";

describe("normalizeGhanaPhone", () => {
  it.each([
    ["local", "0548617924"],
    ["international", "+233548617924"],
    ["without the +", "233548617924"],
    ["with 00", "00233548617924"],
    ["spaces", "054 861 7924"],
    ["dashes", "054-861-7924"],
    ["brackets", "(054) 861 7924"],
    ["dots", "054.861.7924"],
    ["spaces before and after", "   0548617924   "],
    ["tab and newline", "\t0548617924\n"],
    ["spaced international", "+233 54 861 7924"],
    ["dashed international", "+233-54-861-7924"],
    ["international keeping the local 0", "+233 (0) 54 861 7924"],
    ["233 keeping the local 0", "2330548617924"],
    ["non-breaking spaces", "054\u00A0861\u00A07924"],
    ["en dashes", "054\u2013861\u20137924"],
    ["direction marks around a copied number", "\u202A+233 54 861 7924\u202C"],
    ["a trailing left-to-right mark", "0548617924\u200E"],
    ["a zero-width space", "054\u200B8617924"],
    ["a byte-order mark", "\uFEFF0548617924"],
    ["full-width digits", "\uFF10\uFF15\uFF14\uFF18\uFF16\uFF11\uFF17\uFF19\uFF12\uFF14"],
    ["a full-width plus", "\uFF0B233548617924"],
  ])("accepts %s: %j", (_name, input) => {
    expect(normalizeGhanaPhone(input)).toBe(CANONICAL);
  });

  it.each([
    ["too few digits", "054861792"],
    ["too many digits", "05486179245"],
    ["a 233 number one digit short", "23354861792"],
    ["another country", "+15551234567"],
    ["a + on a local number", "+0548617924"],
    ["letters", "054861792a"],
    ["words", "not a phone"],
    ["empty", ""],
    ["only spaces", "   "],
  ])("refuses %s: %j", (_name, input) => {
    expect(normalizeGhanaPhone(input)).toBeNull();
  });
});

describe("helpers", () => {
  it("formatGhanaPhone shows a number back the way people read it", () => {
    expect(formatGhanaPhone("0548617924")).toBe("+233 54 861 7924");
    expect(formatGhanaPhone("not a phone")).toBe("not a phone");
  });

  it("removeInvisibleCharacters and compactPhoneInput keep only what matters", () => {
    expect(removeInvisibleCharacters("\u202A054\u200B861\u202C")).toBe("054861");
    expect(compactPhoneInput(" (054) 861-7924 ")).toBe("0548617924");
  });
});

describe("the phone field with a fixed +233", () => {
  it.each([
    ["548617924", "548617924"],
    ["0548617924", "548617924"],
    ["054 861 7924", "548617924"],
    ["+233 54 861 7924", "548617924"],
    ["+233 (0) 54 861 7924", "548617924"],
    ["233548617924", "548617924"],
    ["00233548617924", "548617924"],
    ["\u202A0548617924\u202C", "548617924"],
  ])("reads a typed or pasted %j as %j", (input, digits) => {
    expect(ghanaSubscriberDigits(input)).toBe(digits);
  });

  it("keeps partial input as typed, dropping only the local 0", () => {
    expect(ghanaSubscriberDigits("")).toBe("");
    expect(ghanaSubscriberDigits("0")).toBe("");
    expect(ghanaSubscriberDigits("054")).toBe("54");
    expect(ghanaSubscriberDigits("54 86")).toBe("5486");
  });

  it("keeps a subscriber number that starts with 233, as long as it is being typed", () => {
    expect(ghanaSubscriberDigits("233")).toBe("233");
    expect(ghanaSubscriberDigits("23 312 3456")).toBe("233123456");
  });

  it("ignores digits past nine", () => {
    expect(ghanaSubscriberDigits("54 861 79241")).toBe("548617924");
  });

  it("groups the digits 2-3-4 as they are typed", () => {
    expect(formatGhanaSubscriber("")).toBe("");
    expect(formatGhanaSubscriber("54")).toBe("54");
    expect(formatGhanaSubscriber("548")).toBe("54 8");
    expect(formatGhanaSubscriber("54860")).toBe("54 860");
    expect(formatGhanaSubscriber("548608146")).toBe("54 860 8146");
  });

  it("round-trips to the canonical number", () => {
    expect(normalizeGhanaPhone(`+233${ghanaSubscriberDigits("054 861 7924")}`)).toBe(CANONICAL);
  });
});
