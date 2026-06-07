import { describe, it, expect } from "vitest";
import {
  PRICING,
  getLoneFare,
  getSharedFarePerRider,
  getSharedTotalFare,
  splitFare,
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
  it("occupancy 1 → 1000 pesewas", () => {
    expect(getSharedFarePerRider(1)).toBe(1000);
  });

  it("occupancy 2 → 700 pesewas", () => {
    expect(getSharedFarePerRider(2)).toBe(700);
  });

  it("occupancy 3 → 600 pesewas", () => {
    expect(getSharedFarePerRider(3)).toBe(600);
  });

  it("occupancy 4 → 500 pesewas", () => {
    expect(getSharedFarePerRider(4)).toBe(500);
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
  it("occupancy 1 → 1000  (1000 × 1)", () => {
    expect(getSharedTotalFare(1)).toBe(1000);
  });

  it("occupancy 2 → 1400  (700 × 2)", () => {
    expect(getSharedTotalFare(2)).toBe(1400);
  });

  it("occupancy 3 → 1800  (600 × 3)", () => {
    expect(getSharedTotalFare(3)).toBe(1800);
  });

  it("occupancy 4 → 2000  (500 × 4)", () => {
    expect(getSharedTotalFare(4)).toBe(2000);
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

  it("exact values at each occupancy are 1000/1400/1800/2000", () => {
    expect(getSharedTotalFare(1)).toBe(1000);
    expect(getSharedTotalFare(2)).toBe(1400);
    expect(getSharedTotalFare(3)).toBe(1800);
    expect(getSharedTotalFare(4)).toBe(2000);
  });
});

// ─── Fare split ───────────────────────────────────────────────────────────────

describe("fare split — commission + driverShare === total (exact invariant)", () => {
  const allTotals = [1000, 1400, 1500, 1800, 2000] as const;

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
  it("occupancy-1 shared per-rider fare is exactly 1000 (lone-shared floor)", () => {
    expect(getSharedFarePerRider(1)).toBe(1000);
  });

  it("no shared rider ever pays more than 1000 pesewas at any occupancy", () => {
    for (const occ of [1, 2, 3, 4] as const) {
      expect(getSharedFarePerRider(occ)).toBeLessThanOrEqual(1000);
    }
  });

  it("full car (occupancy 4) per-rider fare is exactly 500 pesewas", () => {
    expect(getSharedFarePerRider(4)).toBe(500);
  });

  it("shared total at every occupancy is at least 1000 (minimum driver haul)", () => {
    for (const occ of [1, 2, 3, 4] as const) {
      expect(getSharedTotalFare(occ)).toBeGreaterThanOrEqual(1000);
    }
  });
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
  it("occupancy 2: all fields correct", () => {
    const result = priceSharedRide(2);
    expect(result.farePerRider).toBe(700);
    expect(result.total).toBe(1400);
    expect(result.commission).toBe(210);
    expect(result.driverShare).toBe(1190);
    expect(result.commission + result.driverShare).toBe(result.total);
  });

  it("occupancy 3: all fields correct", () => {
    const result = priceSharedRide(3);
    expect(result.farePerRider).toBe(600);
    expect(result.total).toBe(1800);
    expect(result.commission).toBe(270);
    expect(result.driverShare).toBe(1530);
    expect(result.commission + result.driverShare).toBe(result.total);
  });

  it("occupancy 4: all fields correct", () => {
    const result = priceSharedRide(4);
    expect(result.farePerRider).toBe(500);
    expect(result.total).toBe(2000);
    expect(result.commission).toBe(300);
    expect(result.driverShare).toBe(1700);
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
