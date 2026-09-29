import { describe, it, expect } from "vitest";
import { formatCedis, spokenCedis } from "./currency";

describe("formatCedis", () => {
  it("shows whole cedis without decimals", () => {
    expect(formatCedis(500)).toBe("GH₵5");
    expect(formatCedis(1500)).toBe("GH₵15");
    expect(formatCedis(0)).toBe("GH₵0");
  });

  it("shows exactly two decimals otherwise", () => {
    expect(formatCedis(550)).toBe("GH₵5.50");
    expect(formatCedis(505)).toBe("GH₵5.05");
    expect(formatCedis(1)).toBe("GH₵0.01");
  });

  it("formats negatives with a real minus sign (driver net earnings can be negative)", () => {
    expect(formatCedis(-200)).toBe("−GH₵2");
    expect(formatCedis(-250)).toBe("−GH₵2.50");
  });

  it("rounds a stray fractional pesewa rather than printing float noise", () => {
    expect(formatCedis(499.6)).toBe("GH₵5");
    expect(formatCedis(0.1 + 0.2)).toBe("GH₵0");
  });

  it("never throws on a missing amount", () => {
    expect(formatCedis(Number.NaN)).toBe("GH₵—");
  });
});

describe("spokenCedis", () => {
  it("reads naturally", () => {
    expect(spokenCedis(500)).toBe("5 cedis");
    expect(spokenCedis(100)).toBe("1 cedi");
    expect(spokenCedis(550)).toBe("5 cedis 50 pesewas");
    expect(spokenCedis(101)).toBe("1 cedi 1 pesewa");
    expect(spokenCedis(-200)).toBe("minus 2 cedis");
  });
});
