import { describe, expect, it } from "vitest";
import {
  countdownParts,
  countdownWords,
  effectiveLaunchMode,
  isLaunchExempt,
  launchNotOpenMessage,
  launchViewAt,
  opensInText,
  readLaunchStatus,
} from "./launchMode";

const LAUNCH = new Date("2026-11-14T09:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("effectiveLaunchMode", () => {
  it("keeps OFF and LIVE as they are", () => {
    expect(effectiveLaunchMode({ mode: "OFF", launchAt: null }, LAUNCH)).toBe("OFF");
    expect(effectiveLaunchMode({ mode: "LIVE", launchAt: null }, LAUNCH)).toBe("LIVE");
  });

  it("counts down until the launch moment, then is LIVE by itself", () => {
    const stored = { mode: "COUNTDOWN" as const, launchAt: LAUNCH };
    expect(effectiveLaunchMode(stored, new Date(LAUNCH.getTime() - 1))).toBe("COUNTDOWN");
    expect(effectiveLaunchMode(stored, LAUNCH)).toBe("LIVE");
    expect(effectiveLaunchMode(stored, new Date(LAUNCH.getTime() + DAY))).toBe("LIVE");
  });

  it("never blocks anyone with a countdown that has no launch time", () => {
    expect(effectiveLaunchMode({ mode: "COUNTDOWN", launchAt: null }, LAUNCH)).toBe("LIVE");
  });
});

describe("isLaunchExempt", () => {
  const rider = { role: "RIDER", isReviewDemo: false, earlyAccessAt: null };
  it("exempts review demo accounts, admins and early access", () => {
    expect(isLaunchExempt(rider)).toBe(false);
    expect(isLaunchExempt({ ...rider, isReviewDemo: true })).toBe(true);
    expect(isLaunchExempt({ ...rider, role: "ADMIN" })).toBe(true);
    expect(isLaunchExempt({ ...rider, earlyAccessAt: new Date() })).toBe(true);
  });
});

describe("launchNotOpenMessage", () => {
  it("says the day and time in Ghana time (GMT)", () => {
    expect(launchNotOpenMessage(LAUNCH)).toBe(
      "CampusRide opens on Saturday 14 November at 9:00 AM. See you then!",
    );
    expect(launchNotOpenMessage(new Date("2026-12-01T18:30:00Z"))).toBe(
      "CampusRide opens on Tuesday 1 December at 6:30 PM. See you then!",
    );
    expect(launchNotOpenMessage(new Date("2027-01-03T00:05:00Z"))).toContain("Sunday 3 January at 12:05 AM");
  });
});

describe("countdown words", () => {
  it("splits the time left, rounding minutes up", () => {
    expect(countdownParts(2 * DAY + 4 * HOUR + 12 * MINUTE)).toEqual({ days: 2, hours: 4, minutes: 12 });
    expect(countdownParts(30_000)).toEqual({ days: 0, hours: 0, minutes: 1 });
    expect(countdownParts(HOUR - 1)).toEqual({ days: 0, hours: 1, minutes: 0 });
    expect(countdownParts(-5)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });

  it("fits a button", () => {
    expect(opensInText({ days: 2, hours: 4, minutes: 12 })).toBe("Opens in 2d 4h");
    expect(opensInText({ days: 0, hours: 3, minutes: 5 })).toBe("Opens in 3h 5m");
    expect(opensInText({ days: 0, hours: 0, minutes: 7 })).toBe("Opens in 7 min");
  });

  it("reads as a sentence", () => {
    expect(countdownWords({ days: 2, hours: 1, minutes: 12 })).toBe("2 days, 1 hour and 12 minutes");
    expect(countdownWords({ days: 0, hours: 3, minutes: 1 })).toBe("3 hours and 1 minute");
    expect(countdownWords({ days: 0, hours: 0, minutes: 0 })).toBe("1 minute");
  });
});

describe("the countdown on a phone", () => {
  const body = (serverTime: Date, extra: Record<string, unknown> = {}) => ({
    mode: "COUNTDOWN",
    launchAt: LAUNCH.toISOString(),
    serverTime: serverTime.toISOString(),
    ...extra,
  });

  it("runs on the server's clock when the phone's clock is wrong", () => {
    const serverNow = new Date(LAUNCH.getTime() - 2 * HOUR);
    // This phone thinks it is a day later than it is: on its own clock the launch is long past.
    const phoneNow = serverNow.getTime() + DAY;
    const held = readLaunchStatus(body(serverNow), phoneNow);
    expect(held?.clockOffsetMs).toBe(-DAY);

    const view = launchViewAt(held, phoneNow);
    expect(view.kind).toBe("countdown");
    expect(view.kind === "countdown" && view.parts).toEqual({ days: 0, hours: 2, minutes: 0 });

    // Ten minutes later by that same wrong clock: ten minutes less to go.
    const later = launchViewAt(held, phoneNow + 10 * MINUTE);
    expect(later.kind === "countdown" && later.parts).toEqual({ days: 0, hours: 1, minutes: 50 });
  });

  it("also when the phone is behind (it would otherwise show days too many)", () => {
    const serverNow = new Date(LAUNCH.getTime() - 5 * MINUTE);
    const phoneNow = serverNow.getTime() - 3 * DAY;
    const view = launchViewAt(readLaunchStatus(body(serverNow), phoneNow), phoneNow);
    expect(view.kind === "countdown" && view.parts).toEqual({ days: 0, hours: 0, minutes: 5 });
  });

  it("opens by itself at the launch moment, with no new answer from the server", () => {
    const serverNow = new Date(LAUNCH.getTime() - MINUTE);
    const phoneNow = 1_000_000;
    const held = readLaunchStatus(body(serverNow), phoneNow);
    expect(launchViewAt(held, phoneNow + 59_000).kind).toBe("countdown");
    expect(launchViewAt(held, phoneNow + MINUTE).kind).toBe("open");
  });

  it("shows no countdown to someone who can ride, or outside a countdown", () => {
    const serverNow = new Date(LAUNCH.getTime() - DAY);
    const now = serverNow.getTime();
    expect(launchViewAt(readLaunchStatus(body(serverNow, { canRide: true }), now), now).kind).toBe("open");
    expect(launchViewAt(readLaunchStatus(body(serverNow, { canRide: false }), now), now).kind).toBe(
      "countdown",
    );
    expect(launchViewAt(readLaunchStatus(body(serverNow, { mode: "LIVE" }), now), now).kind).toBe("open");
    expect(launchViewAt(readLaunchStatus(body(serverNow, { mode: "OFF" }), now), now).kind).toBe("open");
  });

  it("treats an unreadable answer as no countdown", () => {
    expect(readLaunchStatus(null, 0)).toBeNull();
    expect(readLaunchStatus({ mode: "SOON" }, 0)).toBeNull();
    expect(readLaunchStatus({ mode: "COUNTDOWN", launchAt: "never", serverTime: "x" }, 0)).toBeNull();
    expect(launchViewAt(null, 0)).toEqual({ kind: "open" });
    // No server time: the phone's clock is all there is.
    expect(readLaunchStatus({ mode: "COUNTDOWN", launchAt: LAUNCH.toISOString() }, 5)?.clockOffsetMs).toBe(0);
  });
});
