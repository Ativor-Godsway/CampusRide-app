import { describe, expect, it } from "vitest";
import { DEFAULT_SUPPORT_PHONE, supportPhoneFrom, supportPhoneFromConfig } from "./support";

describe("the support number", () => {
  it("is +233548608146 by default", () => {
    expect(DEFAULT_SUPPORT_PHONE).toBe("+233548608146");
  });

  it("takes the server's number in any Ghana format, as +233…", () => {
    expect(supportPhoneFromConfig({ supportPhone: "+233201234567" })).toBe("+233201234567");
    expect(supportPhoneFromConfig({ supportPhone: "020 123 4567" })).toBe("+233201234567");
    expect(supportPhoneFrom("0548608146")).toBe("+233548608146");
  });

  it("falls back to the built-in number for anything else", () => {
    for (const bad of [undefined, null, "", "not a number", "+44 20 7946 0958", 233548608146]) {
      expect(supportPhoneFrom(bad)).toBe(DEFAULT_SUPPORT_PHONE);
    }
    for (const bad of [undefined, null, "x", {}, { supportPhone: 5 }]) {
      expect(supportPhoneFromConfig(bad)).toBe(DEFAULT_SUPPORT_PHONE);
    }
  });
});
