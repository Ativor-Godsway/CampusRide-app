import { describe, it, expect } from "vitest";
import {
  ASSUMED_AVERAGE_SPEED_KMH,
  MIN_ETA_MINUTES,
  estimateEtaMinutes,
  formatEta,
} from "./eta";

// Legon campus-ish coordinates, far enough apart to be a real trip.
const A = { latitude: 5.6508, longitude: -0.1869 };
const B = { latitude: 5.6608, longitude: -0.1869 }; // ~1.1km due north

describe("estimateEtaMinutes", () => {
  it("returns null when either point is missing", () => {
    expect(estimateEtaMinutes(null, B)).toBeNull();
    expect(estimateEtaMinutes(A, null)).toBeNull();
    expect(estimateEtaMinutes(undefined, undefined)).toBeNull();
  });

  it("estimates a plausible time for a ~1km hop", () => {
    const eta = estimateEtaMinutes(A, B);
    // ~1.1km * 1.3 circuity at 20km/h is roughly 4 minutes.
    expect(eta).toBeGreaterThanOrEqual(3);
    expect(eta).toBeLessThanOrEqual(6);
  });

  it("never promises less than the floor, even at zero distance", () => {
    expect(estimateEtaMinutes(A, A)).toBe(MIN_ETA_MINUTES);
  });

  it("grows with distance", () => {
    const near = estimateEtaMinutes(A, B)!;
    const far = estimateEtaMinutes(A, { latitude: 5.7008, longitude: -0.1869 })!;
    expect(far).toBeGreaterThan(near);
  });

  it("is symmetric", () => {
    expect(estimateEtaMinutes(A, B)).toBe(estimateEtaMinutes(B, A));
  });

  it("goes down as assumed speed goes up", () => {
    const slow = estimateEtaMinutes(A, B, 10)!;
    const fast = estimateEtaMinutes(A, B, 40)!;
    expect(slow).toBeGreaterThan(fast);
  });

  it("rejects a nonsensical speed rather than dividing by zero", () => {
    expect(estimateEtaMinutes(A, B, 0)).toBeNull();
    expect(estimateEtaMinutes(A, B, -5)).toBeNull();
    expect(estimateEtaMinutes(A, B, Number.NaN)).toBeNull();
  });

  it("defaults to the documented campus speed", () => {
    expect(estimateEtaMinutes(A, B)).toBe(estimateEtaMinutes(A, B, ASSUMED_AVERAGE_SPEED_KMH));
  });

  it("returns a whole number of minutes", () => {
    const eta = estimateEtaMinutes(A, B)!;
    expect(Number.isInteger(eta)).toBe(true);
  });
});

describe("formatEta", () => {
  it("says so plainly when there is no estimate", () => {
    expect(formatEta(null)).toBe("ETA unavailable");
  });

  it("hedges with 'about', because this is an estimate not a promise", () => {
    expect(formatEta(4)).toBe("about 4 min");
    expect(formatEta(59)).toBe("about 59 min");
  });

  it("switches to hours past an hour", () => {
    expect(formatEta(60)).toBe("about 1 hr");
    expect(formatEta(75)).toBe("about 1 hr 15 min");
    expect(formatEta(120)).toBe("about 2 hr");
  });
});
