import { describe, it, expect } from "vitest";
import { ghsToPesewas, pesewasToGhs } from "./amounts";

describe("amounts — pesewas <-> GHS conversion at the Moolre boundary", () => {
  it("converts pesewas to a decimal GHS string", () => {
    expect(pesewasToGhs(1275)).toBe("12.75");
    expect(pesewasToGhs(1000)).toBe("10.00");
    expect(pesewasToGhs(5)).toBe("0.05");
    expect(pesewasToGhs(0)).toBe("0.00");
    expect(pesewasToGhs(100)).toBe("1.00");
  });

  it("converts a decimal GHS string back to pesewas", () => {
    expect(ghsToPesewas("12.75")).toBe(1275);
    expect(ghsToPesewas("10.00")).toBe(1000);
    expect(ghsToPesewas("0.05")).toBe(5);
    expect(ghsToPesewas("0.00")).toBe(0);
    expect(ghsToPesewas("1")).toBe(100);
    expect(ghsToPesewas("1.5")).toBe(150);
  });

  it("round-trips exactly with no float drift", () => {
    for (const pesewas of [0, 1, 5, 50, 99, 100, 101, 1000, 1275, 12345, 999999]) {
      expect(ghsToPesewas(pesewasToGhs(pesewas))).toBe(pesewas);
    }
  });

  it("rejects invalid inputs", () => {
    expect(() => pesewasToGhs(-1)).toThrow(RangeError);
    expect(() => pesewasToGhs(1.5)).toThrow(RangeError);
    expect(() => ghsToPesewas("not-a-number")).toThrow(RangeError);
    expect(() => ghsToPesewas("1.2.3")).toThrow(RangeError);
  });
});
