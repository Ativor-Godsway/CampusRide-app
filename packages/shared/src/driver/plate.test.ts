import { describe, expect, it } from "vitest";
import { formatPlateInput } from "./plate";

describe("formatPlateInput", () => {
  it("formats a plate as it's typed", () => {
    expect(formatPlateInput("g")).toBe("G");
    expect(formatPlateInput("gr")).toBe("GR");
    expect(formatPlateInput("gr1")).toBe("GR 1");
    expect(formatPlateInput("gr1234")).toBe("GR 1234");
    expect(formatPlateInput("gr12342")).toBe("GR 1234-2");
    expect(formatPlateInput("GR 1234-24")).toBe("GR 1234-24");
    expect(formatPlateInput("gn-1234-22")).toBe("GN 1234-22");
  });

  it("takes an older plate ending in a letter", () => {
    expect(formatPlateInput("as 4567 x")).toBe("AS 4567-X");
  });

  it("leaves anything else as typed, in capitals", () => {
    expect(formatPlateInput("dv 1234-12 extra")).toBe("DV 1234-12 EXTRA");
    expect(formatPlateInput("")).toBe("");
  });
});
