import { describe, it, expect } from "vitest";
import { DRIVER_CONTACT_TTL_MS, isDriverContactVisible } from "./driverInfo";

const NOW = new Date("2026-09-24T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe("isDriverContactVisible", () => {
  it("is visible while the ride is still running", () => {
    expect(isDriverContactVisible(null, NOW)).toBe(true);
    expect(isDriverContactVisible(undefined, NOW)).toBe(true);
  });

  it("is visible immediately after completion", () => {
    expect(isDriverContactVisible(NOW, NOW)).toBe(true);
  });

  it("is visible the next morning — the 'I left my bag' case", () => {
    expect(isDriverContactVisible(minutesAgo(60 * 12), NOW)).toBe(true);
    expect(isDriverContactVisible(minutesAgo(60 * 23), NOW)).toBe(true);
  });

  it("drops out just after 24 hours", () => {
    const justInside = new Date(NOW.getTime() - DRIVER_CONTACT_TTL_MS + 1000);
    const justOutside = new Date(NOW.getTime() - DRIVER_CONTACT_TTL_MS - 1000);
    expect(isDriverContactVisible(justInside, NOW)).toBe(true);
    expect(isDriverContactVisible(justOutside, NOW)).toBe(false);
  });

  it("stays hidden for an old ride", () => {
    expect(isDriverContactVisible(minutesAgo(60 * 24 * 30), NOW)).toBe(false);
  });

  it("uses a 24-hour window", () => {
    expect(DRIVER_CONTACT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
