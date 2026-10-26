import { describe, expect, it } from "vitest";
import { initialsOf } from "./names";

describe("initialsOf", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsOf("Kwame Mensah")).toBe("KM");
    expect(initialsOf("  akosua  serwaa boateng ")).toBe("AS");
    expect(initialsOf("Kwame Mensah", 1)).toBe("K");
  });

  it("uses letters only, skipping words that start with anything else", () => {
    expect(initialsOf("Kwame (test)")).toBe("K");
    expect(initialsOf("(test) Kwame")).toBe("K");
    expect(initialsOf("Kwame 2 Mensah")).toBe("KM");
    expect(initialsOf("Ɛfua Ɔwusu")).toBe("ƐƆ");
  });

  it("is empty when there is no letter to show", () => {
    expect(initialsOf("")).toBe("");
    expect(initialsOf(null)).toBe("");
    expect(initialsOf("(test) 123")).toBe("");
  });
});
