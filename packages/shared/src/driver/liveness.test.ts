import { describe, expect, it } from "vitest";
import { DRIVER_AUTO_OFFLINE_MESSAGE, DRIVER_STALE_AFTER_MS, isDriverLive } from "./liveness";

describe("driver liveness", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  it("is 10 minutes", () => {
    expect(DRIVER_STALE_AFTER_MS).toBe(10 * 60_000);
  });
  it("live within 10 minutes of the last heartbeat, stale after, never heard is stale", () => {
    expect(isDriverLive(new Date(now - 9 * 60_000), now)).toBe(true);
    expect(isDriverLive(now - 10 * 60_000, now)).toBe(true);
    expect(isDriverLive(now - 10 * 60_000 - 1, now)).toBe(false);
    expect(isDriverLive(null, now)).toBe(false);
    expect(isDriverLive(undefined, now)).toBe(false);
  });
  it("says why in the owner's words", () => {
    expect(DRIVER_AUTO_OFFLINE_MESSAGE).toBe("You were set offline because your app lost connection. Go online again to get requests.");
  });
});
