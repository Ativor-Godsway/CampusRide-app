import { describe, expect, it } from "vitest";
import { isTransientRequestFailure, planZoneUpdate, ZONE_UPDATE_MIN_INTERVAL_MS } from "./zoneUpdate";

describe("planZoneUpdate", () => {
  it("does nothing when the zone hasn't changed, or is unknown", () => {
    const state = { lastSentZoneId: "z1", lastSentAt: 0 };
    expect(planZoneUpdate(state, "z1", 999_999)).toEqual({ kind: "none" });
    expect(planZoneUpdate(state, null, 999_999)).toEqual({ kind: "none" });
  });

  it("sends the first correction straight away (the zone sent when going online isn't throttled)", () => {
    expect(planZoneUpdate({ lastSentZoneId: "z1", lastSentAt: null }, "z2", 5)).toEqual({ kind: "send" });
    expect(planZoneUpdate({ lastSentZoneId: null, lastSentAt: null }, "z2", 5)).toEqual({ kind: "send" });
  });

  it("sends at most once per interval, and a change inside it waits for the window to close", () => {
    const state = { lastSentZoneId: "z1", lastSentAt: 100_000 };
    expect(planZoneUpdate(state, "z2", 110_000)).toEqual({ kind: "wait", delayMs: 20_000 });
    expect(planZoneUpdate(state, "z2", 100_000 + ZONE_UPDATE_MIN_INTERVAL_MS)).toEqual({ kind: "send" });
  });
});

describe("isTransientRequestFailure", () => {
  it("retries no-response failures and gateway errors", () => {
    expect(isTransientRequestFailure({})).toBe(true);
    expect(isTransientRequestFailure({ status: 0 })).toBe(true);
    expect(isTransientRequestFailure({ status: 502 })).toBe(true);
    expect(isTransientRequestFailure({ status: 503 })).toBe(true);
    expect(isTransientRequestFailure({ status: 504 })).toBe(true);
  });

  it("never retries a real answer", () => {
    expect(isTransientRequestFailure({ status: 403 })).toBe(false);
    expect(isTransientRequestFailure({ status: 409 })).toBe(false);
    expect(isTransientRequestFailure({ status: 500 })).toBe(false);
  });
});
