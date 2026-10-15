import { describe, expect, it } from "vitest";
import {
  compactPhoneInput,
  formatGhanaPhone,
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
