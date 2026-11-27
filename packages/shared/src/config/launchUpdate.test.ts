import { describe, expect, it } from "vitest";
import { LAUNCH_UPDATE_MAX_MS, launchUpdateStep, withinLaunchBudget } from "./launchUpdate";

describe("launch update", () => {
  it("applies now with no ride; next launch during one; nothing when off or none", () => {
    expect(launchUpdateStep({ updatesEnabled: true, available: true, rideActive: false })).toBe("apply-now");
    expect(launchUpdateStep({ updatesEnabled: true, available: true, rideActive: true })).toBe("next-launch");
    expect(launchUpdateStep({ updatesEnabled: true, available: false, rideActive: false })).toBe("none");
    expect(launchUpdateStep({ updatesEnabled: false, available: true, rideActive: false })).toBe("none");
  });
  it("waits at most 8 seconds", () => {
    expect(LAUNCH_UPDATE_MAX_MS).toBe(8000);
    expect(withinLaunchBudget(0, 7999)).toBe(true);
    expect(withinLaunchBudget(0, 8000)).toBe(false);
  });
});
