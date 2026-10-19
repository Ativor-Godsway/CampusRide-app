import { describe, expect, it } from "vitest";
import {
  DRIVER_LOCATION_DISCLOSURE,
  DRIVER_ONLINE_NOTIFICATION,
  accessFromAlwaysAnswer,
  isExpoGoMissingAlwaysKey,
  planLocationAccess,
  type LocationPermissions,
} from "./locationAccess";

const perms = (p: Partial<LocationPermissions>): LocationPermissions => ({
  foreground: "undetermined",
  foregroundCanAsk: true,
  background: "undetermined",
  backgroundCanAsk: true,
  ...p,
});

describe("planLocationAccess", () => {
  it("shows the disclosure before the very first prompt", () => {
    expect(planLocationAccess(perms({}))).toBe("disclose");
  });

  it("shows it again before asking for background, once foreground is allowed", () => {
    expect(planLocationAccess(perms({ foreground: "granted" }))).toBe("disclose");
  });

  it("goes straight online when everything is allowed", () => {
    expect(planLocationAccess(perms({ foreground: "granted", background: "granted" }))).toBe(
      "always",
    );
  });

  it("doesn't nag a driver who said no to background: online while the app is open", () => {
    expect(planLocationAccess(perms({ foreground: "granted", background: "denied" }))).toBe(
      "whileUsing",
    );
    expect(
      planLocationAccess(
        perms({ foreground: "granted", background: "undetermined", backgroundCanAsk: false }),
      ),
    ).toBe("whileUsing");
  });

  it("sends a driver who refused location for good to Settings", () => {
    expect(planLocationAccess(perms({ foreground: "denied", foregroundCanAsk: false }))).toBe(
      "settings",
    );
    expect(planLocationAccess(perms({ foreground: "denied", foregroundCanAsk: true }))).toBe(
      "disclose",
    );
  });
});

describe("the wording Google and Apple look for", () => {
  it("the disclosure says what, what for, and 'even when the app is closed or not in use'", () => {
    expect(DRIVER_LOCATION_DISCLOSURE.body).toContain("collects location data");
    expect(DRIVER_LOCATION_DISCLOSURE.body).toContain("share your position with riders");
    expect(DRIVER_LOCATION_DISCLOSURE.body).toContain("match you with nearby ride requests");
    expect(DRIVER_LOCATION_DISCLOSURE.body).toContain("even when the app is closed or not in use");
    expect([DRIVER_LOCATION_DISCLOSURE.accept, DRIVER_LOCATION_DISCLOSURE.decline]).toEqual([
      "Continue",
      "Not now",
    ]);
  });

  it("the online notification", () => {
    expect(`${DRIVER_ONLINE_NOTIFICATION.title}. ${DRIVER_ONLINE_NOTIFICATION.body}`).toBe(
      "You're online. CampusRide Driver is sharing your location.",
    );
  });
});

describe("the answer to the 'all the time' prompt", () => {
  const infoPlistError = Object.assign(new Error("NSLocation*UsageDescription missing"), {
    code: "ERR_LOCATION_INFO_PLIST",
  });

  it("goes online in the background when the driver allows it", () => {
    expect(accessFromAlwaysAnswer("granted")).toBe("always");
  });

  it("store build, driver says no: 'while using', as before (the go-online flow explains it)", () => {
    expect(accessFromAlwaysAnswer("denied")).toBe("whileUsing");
    expect(accessFromAlwaysAnswer("undetermined")).toBe("whileUsing");
  });

  it("Expo Go's missing Info.plist key counts as 'while using'", () => {
    expect(isExpoGoMissingAlwaysKey(infoPlistError, true)).toBe(true);
  });

  it("the same error in a store build does not", () => {
    expect(isExpoGoMissingAlwaysKey(infoPlistError, false)).toBe(false);
  });

  it("any other failure in Expo Go does not", () => {
    const other = Object.assign(new Error("location services off"), {
      code: "E_LOCATION_SERVICES_DISABLED",
    });
    expect(isExpoGoMissingAlwaysKey(other, true)).toBe(false);
    expect(isExpoGoMissingAlwaysKey(new Error("no code"), true)).toBe(false);
    expect(isExpoGoMissingAlwaysKey(null, true)).toBe(false);
    expect(isExpoGoMissingAlwaysKey("ERR_LOCATION_INFO_PLIST", true)).toBe(false);
  });
});
