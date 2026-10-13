import { describe, expect, it } from "vitest";
import { shouldKeepScreenAwake } from "./keepAwake";

describe("keeping the driver's screen awake", () => {
  it("only while signed in as a driver AND online", () => {
    expect(shouldKeepScreenAwake({ signedInAsDriver: true, isOnline: true })).toBe(true);
    expect(shouldKeepScreenAwake({ signedInAsDriver: true, isOnline: false })).toBe(false); // went offline
    expect(shouldKeepScreenAwake({ signedInAsDriver: false, isOnline: true })).toBe(false); // signed out
    expect(shouldKeepScreenAwake({ signedInAsDriver: false, isOnline: false })).toBe(false);
  });
});
