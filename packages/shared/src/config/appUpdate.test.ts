import { describe, expect, it } from "vitest";
import {
  NO_UPDATE_REQUIRED,
  compareVersions,
  holdUpdateScreen,
  nextUpdateRequirement,
  normalizeStoreUrl,
  parseVersion,
  showUpdateScreen,
  updateRequirement,
  type AppMinVersions,
} from "./appUpdate";

const PLAY_RIDER = "https://play.google.com/store/apps/details?id=com.campusride.rider";

function answer(
  rider: Partial<AppMinVersions["rider"]["android"]> = {},
  overrides: Partial<AppMinVersions> = {},
): AppMinVersions {
  const unset = { minVersion: null, storeUrl: null };
  return {
    rider: { ios: unset, android: { minVersion: null, storeUrl: PLAY_RIDER, ...rider } },
    driver: { ios: unset, android: unset },
    ...overrides,
  };
}

describe("compareVersions", () => {
  it("compares each part as a number, not as text", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("1.4.2", "1.4.2")).toBe(0);
  });

  it("reads a short version as zeros at the end", () => {
    expect(parseVersion("1")).toEqual([1, 0, 0]);
    expect(parseVersion("1.2")).toEqual([1, 2, 0]);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions(" 1.1.0 ", "1.1")).toBe(0);
  });

  it("is null when either side isn't a version", () => {
    for (const bad of ["", "abc", "1.0.0-beta", "v1.0.0", "1.0.0.0", "1..0", null, undefined]) {
      expect(parseVersion(bad)).toBeNull();
      expect(compareVersions(bad, "1.0.0")).toBeNull();
      expect(compareVersions("1.0.0", bad)).toBeNull();
    }
  });
});

describe("normalizeStoreUrl", () => {
  it("keeps an https link and drops anything else", () => {
    expect(normalizeStoreUrl(` ${PLAY_RIDER} `)).toBe(PLAY_RIDER);
    expect(normalizeStoreUrl("http://example.com")).toBeNull();
    expect(normalizeStoreUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeStoreUrl("")).toBeNull();
    expect(normalizeStoreUrl(undefined)).toBeNull();
  });
});

describe("updateRequirement", () => {
  it("blocks a version below the minimum, with the store link", () => {
    expect(updateRequirement(answer({ minVersion: "1.1.0" }), "rider", "android", "1.0.0")).toEqual({
      required: true,
      storeUrl: PLAY_RIDER,
    });
  });

  it("lets the minimum itself, and anything newer, in", () => {
    const a = answer({ minVersion: "1.1.0" });
    expect(updateRequirement(a, "rider", "android", "1.1.0").required).toBe(false);
    expect(updateRequirement(a, "rider", "android", "1.2.0").required).toBe(false);
  });

  it("blocks nobody when the minimum is unset", () => {
    expect(updateRequirement(answer(), "rider", "android", "0.0.1").required).toBe(false);
    expect(updateRequirement(answer({ minVersion: "1.1.0" }), "rider", "ios", "1.0.0").required).toBe(false);
    expect(updateRequirement(answer({ minVersion: "1.1.0" }), "driver", "android", "1.0.0").required).toBe(false);
  });

  it("keeps each app and platform to its own values", () => {
    const a = answer({}, {
      driver: { ios: { minVersion: "3.0.0", storeUrl: null }, android: { minVersion: null, storeUrl: null } },
    });
    expect(updateRequirement(a, "driver", "ios", "2.0.0")).toEqual({ required: true, storeUrl: null });
    expect(updateRequirement(a, "driver", "android", "2.0.0").required).toBe(false);
    expect(updateRequirement(a, "rider", "ios", "2.0.0").required).toBe(false);
  });

  it("blocks nobody on a malformed answer, minimum or installed version", () => {
    const blocked = answer({ minVersion: "9.0.0" });
    expect(updateRequirement(null, "rider", "android", "1.0.0")).toEqual(NO_UPDATE_REQUIRED);
    expect(updateRequirement("<html>", "rider", "android", "1.0.0")).toEqual(NO_UPDATE_REQUIRED);
    expect(updateRequirement({ rider: {} }, "rider", "android", "1.0.0")).toEqual(NO_UPDATE_REQUIRED);
    expect(updateRequirement(answer({ minVersion: "soon" }), "rider", "android", "1.0.0").required).toBe(false);
    expect(updateRequirement({ rider: { android: { minVersion: 2 } } }, "rider", "android", "1.0.0").required).toBe(false);
    expect(updateRequirement(blocked, "rider", "android", null).required).toBe(false);
    expect(updateRequirement(blocked, "rider", "android", "1.0.0-dev").required).toBe(false);
    expect(updateRequirement(blocked, "rider", "web", "1.0.0").required).toBe(false);
  });

  it("drops a store link that isn't https", () => {
    const a = answer({ minVersion: "2.0.0", storeUrl: "market://details?id=x" });
    expect(updateRequirement(a, "rider", "android", "1.0.0")).toEqual({ required: true, storeUrl: null });
  });
});

describe("nextUpdateRequirement (fail open)", () => {
  const required = { required: true, storeUrl: PLAY_RIDER };

  it("lets the person in when the first check fails", () => {
    expect(nextUpdateRequirement(NO_UPDATE_REQUIRED, { ok: false })).toEqual(NO_UPDATE_REQUIRED);
  });

  it("keeps a screen that is up when a later check fails", () => {
    expect(nextUpdateRequirement(required, { ok: false })).toEqual(required);
  });

  it("follows every answered check, both ways", () => {
    expect(nextUpdateRequirement(NO_UPDATE_REQUIRED, { ok: true, requirement: required })).toEqual(required);
    expect(nextUpdateRequirement(required, { ok: true, requirement: NO_UPDATE_REQUIRED })).toEqual(NO_UPDATE_REQUIRED);
  });
});

describe("the trip rule", () => {
  const required = { required: true, storeUrl: null };

  it("holds the screen while a trip is going on, might be, or its screen is open", () => {
    expect(holdUpdateScreen({ trip: "active", onTripScreen: true })).toBe(true);
    expect(holdUpdateScreen({ trip: "active", onTripScreen: false })).toBe(true);
    expect(holdUpdateScreen({ trip: "unknown", onTripScreen: false })).toBe(true);
    expect(holdUpdateScreen({ trip: "none", onTripScreen: true })).toBe(true);
    expect(showUpdateScreen(required, true)).toBe(false);
  });

  it("shows it once the trip has ended and its screen is closed", () => {
    expect(holdUpdateScreen({ trip: "none", onTripScreen: false })).toBe(false);
    expect(showUpdateScreen(required, false)).toBe(true);
  });

  it("never shows it when no update is required", () => {
    expect(showUpdateScreen(NO_UPDATE_REQUIRED, false)).toBe(false);
  });
});
