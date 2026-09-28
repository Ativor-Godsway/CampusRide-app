import { describe, it, expect } from "vitest";
import { DISPATCH_WINDOW_MS, dispatchSecondsLeft } from "./dispatchWindow";

const START = new Date("2026-09-28T10:00:00.000Z");

describe("dispatchSecondsLeft", () => {
  it("counts down the 90s window", () => {
    expect(DISPATCH_WINDOW_MS).toBe(90_000);
    expect(dispatchSecondsLeft(START, START.getTime())).toBe(90);
    expect(dispatchSecondsLeft(START.toISOString(), START.getTime() + 30_500)).toBe(60);
  });

  it("stops at 0 rather than going negative", () => {
    expect(dispatchSecondsLeft(START, START.getTime() + 200_000)).toBe(0);
  });

  it("is null when there is no (valid) start", () => {
    expect(dispatchSecondsLeft(null, Date.now())).toBeNull();
    expect(dispatchSecondsLeft("not a date", Date.now())).toBeNull();
  });
});
