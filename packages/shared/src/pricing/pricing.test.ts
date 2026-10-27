import { describe, it, expect } from "vitest";
import {
  PRICING,
  getLoneFare,
  getSharedFarePerRider,
  getSharedTotalFare,
  splitFare,
  getDriverGrossForRide,
  priceLoneRide,
  priceSharedRide,
  validateLoneOccupancy,
  validateSharedOccupancy,
  InvalidOccupancyError,
} from "./pricing";

// ─── LONE ─────────────────────────────────────────────────────────────────────

describe("LONE fare", () => {
  it("getLoneFare returns 1500 pesewas", () => {
    expect(getLoneFare()).toBe(1500);
  });

  it("priceLoneRide total is 1500", () => {
    expect(priceLoneRide().total).toBe(1500);
  });

  it("validateLoneOccupancy accepts 1", () => {
    expect(() => validateLoneOccupancy(1)).not.toThrow();
  });

  it("validateLoneOccupancy throws for occupancy 0", () => {
    expect(() => validateLoneOccupancy(0)).toThrow(InvalidOccupancyError);
  });

  it("validateLoneOccupancy throws for occupancy 2", () => {
    expect(() => validateLoneOccupancy(2)).toThrow(InvalidOccupancyError);
  });

  it("error message mentions the invalid occupancy value", () => {
    expect(() => validateLoneOccupancy(3)).toThrowError("3");
  });
});

// ─── SHARED per-rider fare ────────────────────────────────────────────────────

describe("SHARED per-rider fare", () => {
  it("occupancy 1 → 700 pesewas (flat)", () => {
    expect(getSharedFarePerRider(1)).toBe(700);
  });

  it("occupancy 2 → 700 pesewas (flat)", () => {
    expect(getSharedFarePerRider(2)).toBe(700);
  });

  it("occupancy 3 → 700 pesewas (flat)", () => {
    expect(getSharedFarePerRider(3)).toBe(700);
  });

  it("occupancy 4 → 700 pesewas (flat)", () => {
    expect(getSharedFarePerRider(4)).toBe(700);
  });

  it("throws InvalidOccupancyError for occupancy 0", () => {
    expect(() => getSharedFarePerRider(0)).toThrow(InvalidOccupancyError);
  });

  it("throws InvalidOccupancyError for occupancy 5", () => {
    expect(() => getSharedFarePerRider(5)).toThrow(InvalidOccupancyError);
  });

  it("throws for non-integer occupancy", () => {
    expect(() => getSharedFarePerRider(2.5)).toThrow(InvalidOccupancyError);
  });
});

// ─── SHARED total fare ────────────────────────────────────────────────────────

describe("SHARED total fare", () => {
  it("occupancy 1 → 700  (700 × 1)", () => {
    expect(getSharedTotalFare(1)).toBe(700);
  });

  it("occupancy 2 → 1400  (700 × 2)", () => {
    expect(getSharedTotalFare(2)).toBe(1400);
  });

  it("occupancy 3 → 2100  (700 × 3)", () => {
    expect(getSharedTotalFare(3)).toBe(2100);
  });

  it("occupancy 4 → 2800  (700 × 4)", () => {
    expect(getSharedTotalFare(4)).toBe(2800);
  });

  it("throws for occupancy 0", () => {
    expect(() => getSharedTotalFare(0)).toThrow(InvalidOccupancyError);
  });

  it("throws for occupancy 5", () => {
    expect(() => getSharedTotalFare(5)).toThrow(InvalidOccupancyError);
  });
});

// ─── Haul-climbs invariant ────────────────────────────────────────────────────

describe("haul-climbs invariant", () => {
  it("shared total strictly increases from occupancy 1 → 2 → 3 → 4", () => {
    const totals = ([1, 2, 3, 4] as const).map((occ) => getSharedTotalFare(occ));
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]).toBeGreaterThan(totals[i - 1]!);
    }
  });

  it("exact values at each occupancy are 700/1400/2100/2800", () => {
    expect(getSharedTotalFare(1)).toBe(700);
    expect(getSharedTotalFare(2)).toBe(1400);
    expect(getSharedTotalFare(3)).toBe(2100);
    expect(getSharedTotalFare(4)).toBe(2800);
  });
});

// ─── Fare split ───────────────────────────────────────────────────────────────

describe("fare split — commission + driverShare === total (exact invariant)", () => {
  const allTotals = [700, 1000, 1400, 1500, 1800, 2000, 2100, 2800] as const;

  for (const total of allTotals) {
    it(`total ${total}: commission + driverShare === ${total}`, () => {
      const { commission, driverShare } = splitFare(total);
      expect(commission + driverShare).toBe(total);
    });
  }

  for (const total of allTotals) {
    it(`total ${total}: commission within 1 pesewa of 15%`, () => {
      const { commission } = splitFare(total);
      const exact15pct = (total * PRICING.COMMISSION_PCT) / PRICING.COMMISSION_BASE;
      expect(Math.abs(commission - exact15pct)).toBeLessThan(1);
    });
  }
});

describe("fare split — spot-checks", () => {
  it("total 1000 → commission 150, driverShare 850", () => {
    const { commission, driverShare } = splitFare(1000);
    expect(commission).toBe(150);
    expect(driverShare).toBe(850);
  });

  it("total 1400 → commission 210, driverShare 1190", () => {
    const { commission, driverShare } = splitFare(1400);
    expect(commission).toBe(210);
    expect(driverShare).toBe(1190);
  });

  it("total 1500 → commission 225, driverShare 1275", () => {
    const { commission, driverShare } = splitFare(1500);
    expect(commission).toBe(225);
    expect(driverShare).toBe(1275);
  });

  it("total 1800 → commission 270, driverShare 1530", () => {
    const { commission, driverShare } = splitFare(1800);
    expect(commission).toBe(270);
    expect(driverShare).toBe(1530);
  });

  it("total 2000 → commission 300, driverShare 1700", () => {
    const { commission, driverShare } = splitFare(2000);
    expect(commission).toBe(300);
    expect(driverShare).toBe(1700);
  });
});

// ─── Competitive guarantees ───────────────────────────────────────────────────

describe("competitive guarantees", () => {
  it("every shared rider pays exactly 700 pesewas, regardless of occupancy", () => {
    for (const occ of [1, 2, 3, 4] as const) {
      expect(getSharedFarePerRider(occ)).toBe(700);
    }
  });

  it("a shared rider gives the driver GH₵5.95 and CampusRide GH₵1.05", () => {
    expect(splitFare(getSharedFarePerRider(1))).toEqual({ commission: 105, driverShare: 595 });
    expect(getDriverGrossForRide("SHARED", 1)).toBe(595);
  });

  it("sharing always costs a rider less than riding alone", () => {
    for (const occ of [1, 2, 3, 4] as const) {
      expect(getSharedFarePerRider(occ)).toBeLessThan(getLoneFare());
    }
  });

  // The old "≥1000 minimum driver haul" guarantee is intentionally removed:
  // a solo SHARED rider now nets the driver 700 total, not 1000.
});

// ─── Convenience combiners ────────────────────────────────────────────────────

describe("priceLoneRide", () => {
  it("returns correct fare/commission/driverShare/total shape", () => {
    const result = priceLoneRide();
    expect(result.fare).toBe(1500);
    expect(result.total).toBe(1500);
    expect(result.commission).toBe(225);
    expect(result.driverShare).toBe(1275);
    expect(result.commission + result.driverShare).toBe(result.total);
  });
});

describe("priceSharedRide", () => {
  it("occupancy 2: flat farePerRider, total scales with headcount", () => {
    const result = priceSharedRide(2);
    expect(result.farePerRider).toBe(700);
    expect(result.total).toBe(1400);
    expect(result.commission).toBe(210);
    expect(result.driverShare).toBe(1190);
    expect(result.commission + result.driverShare).toBe(result.total);
  });

  it("occupancy 3: flat farePerRider, total scales with headcount", () => {
    const result = priceSharedRide(3);
    expect(result.farePerRider).toBe(700);
    expect(result.total).toBe(2100);
    expect(result.commission).toBe(315);
    expect(result.driverShare).toBe(1785);
    expect(result.commission + result.driverShare).toBe(result.total);
  });

  it("occupancy 4: flat farePerRider, total scales with headcount", () => {
    const result = priceSharedRide(4);
    expect(result.farePerRider).toBe(700);
    expect(result.total).toBe(2800);
    expect(result.commission).toBe(420);
    expect(result.driverShare).toBe(2380);
    expect(result.commission + result.driverShare).toBe(result.total);
  });

  it("throws InvalidOccupancyError for occupancy 5", () => {
    expect(() => priceSharedRide(5)).toThrow(InvalidOccupancyError);
  });

  it("invariant holds at every valid occupancy", () => {
    for (const occ of [1, 2, 3, 4] as const) {
      const { commission, driverShare, total } = priceSharedRide(occ);
      expect(commission + driverShare).toBe(total);
    }
  });
});

// ─── validateSharedOccupancy (direct) ────────────────────────────────────────

describe("validateSharedOccupancy", () => {
  it("accepts 1, 2, 3, 4 without throwing", () => {
    for (const occ of [1, 2, 3, 4]) {
      expect(() => validateSharedOccupancy(occ)).not.toThrow();
    }
  });

  it("throws for 0", () => {
    expect(() => validateSharedOccupancy(0)).toThrow(InvalidOccupancyError);
  });

  it("throws for 5", () => {
    expect(() => validateSharedOccupancy(5)).toThrow(InvalidOccupancyError);
  });

  it("throws for negative values", () => {
    expect(() => validateSharedOccupancy(-1)).toThrow(InvalidOccupancyError);
  });

  it("throws for non-integer values", () => {
    expect(() => validateSharedOccupancy(1.5)).toThrow(InvalidOccupancyError);
  });
});
