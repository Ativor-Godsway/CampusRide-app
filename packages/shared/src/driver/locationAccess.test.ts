import { describe, expect, it } from "vitest";
import {
  DRIVER_LOCATION_DISCLOSURE,
  DRIVER_ONLINE_NOTIFICATION,
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
