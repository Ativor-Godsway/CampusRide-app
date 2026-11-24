import { describe, expect, it } from "vitest";
import {
  ACCRA_UTC_OFFSET_MINUTES,
  DEFAULT_SERVICE_SETTINGS,
  DEFAULT_WEEKLY_SCHEDULE,
  NO_DRIVERS_TEXT,
  SERVICE_TIME_ZONE,
  accraWeekday,
  driverServiceNotice,
  holdServiceStatus,
  overrideEnd,
  overrideInForce,
  readServiceStatus,
  readWeeklySchedule,
  scheduleAt,
  serviceClosedText,
  serviceStateAt,
  serviceStateLine,
  serviceStatusFromState,
  serviceViewAt,
  type ServiceSettings,
  type WeeklySchedule,
} from "./serviceHours";

// Tuesday 24 November 2026 in Accra (= UTC).
const at = (iso: string) => new Date(`${iso}Z`);
const TUE = "2026-11-24";
const MINUTE = 60_000;

function settings(over: Partial<ServiceSettings> = {}): ServiceSettings {
  return { ...DEFAULT_SERVICE_SETTINGS, ...over };
}

/** Every day 08:00–17:00 except the days given. */
function weekly(days: Partial<Record<number, { open: string; close: string } | null>>): WeeklySchedule {
  return DEFAULT_WEEKLY_SCHEDULE.map((d, i) => (i in days ? days[i]! : d));
}

describe("Africa/Accra", () => {
  it("is UTC+0 all year, so Accra wall-clock time is the UTC clock", () => {
    expect(SERVICE_TIME_ZONE).toBe("Africa/Accra");
    expect(ACCRA_UTC_OFFSET_MINUTES).toBe(0);
    for (const iso of ["2026-01-15T07:59:00Z", "2026-06-21T16:59:00Z", "2026-11-24T23:30:00Z"]) {
      const d = new Date(iso);
      const accra = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Accra",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "long",
        hourCycle: "h23",
      }).format(d);
      const utc = new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "long",
        hourCycle: "h23",
      }).format(d);
      expect(accra).toBe(utc);
    }
    expect(accraWeekday(at(`${TUE}T23:59:59`))).toBe(2);
  });
});

describe("the schedule", () => {
  it("opens exactly at the opening minute and closes exactly at the closing minute", () => {
    const w = DEFAULT_WEEKLY_SCHEDULE;
    expect(scheduleAt(w, new Date(at(`${TUE}T08:00`).getTime() - 1)).open).toBe(false);
    expect(scheduleAt(w, at(`${TUE}T08:00`))).toEqual({
      open: true,
      closesAt: at(`${TUE}T17:00`),
      nextOpenAt: null,
    });
    expect(scheduleAt(w, new Date(at(`${TUE}T17:00`).getTime() - 1)).open).toBe(true);
    expect(scheduleAt(w, at(`${TUE}T17:00`))).toEqual({
      open: false,
      closesAt: null,
      nextOpenAt: at("2026-11-25T08:00"),
    });
  });

  it("before opening, the next opening is today", () => {
    expect(scheduleAt(DEFAULT_WEEKLY_SCHEDULE, at(`${TUE}T06:30`)).nextOpenAt).toEqual(at(`${TUE}T08:00`));
  });

  it("skips closed days", () => {
    // Saturday (6) and Sunday (0) closed: Friday evening opens again Monday.
    const w = weekly({ 6: null, 0: null });
    const friday = at("2026-11-27T18:00");
    expect(scheduleAt(w, friday).nextOpenAt).toEqual(at("2026-11-30T08:00"));
    expect(scheduleAt(w, at("2026-11-28T12:00")).open).toBe(false);
  });

  it("is overnight-safe: a closing time at or before the opening runs past midnight", () => {
    const w: WeeklySchedule = Array.from({ length: 7 }, () => ({ open: "20:00", close: "02:00" }));
    expect(scheduleAt(w, at(`${TUE}T19:59`)).open).toBe(false);
    expect(scheduleAt(w, at(`${TUE}T23:30`))).toEqual({
      open: true,
      closesAt: at("2026-11-25T02:00"),
      nextOpenAt: null,
    });
    // 01:00 on Tuesday is Monday night's stretch.
    expect(scheduleAt(w, at(`${TUE}T01:00`)).closesAt).toEqual(at(`${TUE}T02:00`));
    expect(scheduleAt(w, at(`${TUE}T02:00`)).nextOpenAt).toEqual(at(`${TUE}T20:00`));
  });

  it("joins back-to-back days, and has no closing time when it never closes", () => {
    const allDay = { open: "00:00", close: "24:00" };
    const w = weekly({ 1: allDay, 2: { open: "00:00", close: "12:00" } });
    expect(scheduleAt(w, at("2026-11-23T15:00")).closesAt).toEqual(at(`${TUE}T12:00`));
    const always: WeeklySchedule = Array.from({ length: 7 }, () => allDay);
    expect(scheduleAt(always, at(`${TUE}T03:00`))).toEqual({ open: true, closesAt: null, nextOpenAt: null });
  });

  it("never opens when every day is closed", () => {
    const closed: WeeklySchedule = Array.from({ length: 7 }, () => null);
    expect(scheduleAt(closed, at(`${TUE}T10:00`))).toEqual({ open: false, closesAt: null, nextOpenAt: null });
  });

  it("checks what the admin site sends", () => {
    expect(readWeeklySchedule(DEFAULT_WEEKLY_SCHEDULE)).toEqual({ weekly: DEFAULT_WEEKLY_SCHEDULE });
    expect(readWeeklySchedule([])).toEqual({ error: "The schedule needs all 7 days." });
    expect(readWeeklySchedule(weekly({ 1: { open: "8:00", close: "17:00" } }))).toEqual({
      error: "Monday: opening and closing times must be like 08:00.",
    });
    expect(readWeeklySchedule(weekly({ 3: { open: "09:00", close: "09:00" } }))).toHaveProperty("error");
    expect(readWeeklySchedule(weekly({ 3: { open: "24:00", close: "09:00" } }))).toHaveProperty("error");
    expect(readWeeklySchedule(weekly({ 3: { open: "00:00", close: "24:00" } }))).toHaveProperty("weekly");
  });
});

describe("manual override", () => {
  const w = DEFAULT_WEEKLY_SCHEDULE;

  it("Close now at 3 pm stays closed until tomorrow's opening, then the schedule takes over", () => {
    const setAt = at(`${TUE}T15:00`);
    const until = overrideEnd(w, "CLOSED", setAt);
    expect(until).toEqual(at("2026-11-25T08:00"));
    const s = settings({ override: { mode: "CLOSED", until } });

    expect(serviceStateAt(s, setAt, 3)).toMatchObject({ open: false, reason: "MANUAL", nextOpenAt: until });
    expect(serviceStateAt(s, at(`${TUE}T16:00`), 3).open).toBe(false);
    expect(serviceStateAt(s, new Date(until!.getTime() - 1), 3).open).toBe(false);
    // At the opening minute exactly the override is over: the schedule says open.
    expect(overrideInForce(s.override, until!)).toBe(false);
    expect(serviceStateAt(s, until!, 3)).toMatchObject({ open: true, reason: "SCHEDULE", closesAt: at("2026-11-25T17:00") });
  });

  it("Close now before opening lasts only until that morning's opening", () => {
    expect(overrideEnd(w, "CLOSED", at(`${TUE}T07:00`))).toEqual(at(`${TUE}T08:00`));
  });

  it("Open now in the evening stays open until the next scheduled closing", () => {
    const setAt = at(`${TUE}T19:00`);
    const until = overrideEnd(w, "OPEN", setAt);
    expect(until).toEqual(at("2026-11-25T17:00"));
    const s = settings({ override: { mode: "OPEN", until } });
    expect(serviceStateAt(s, at(`${TUE}T23:00`), 1)).toMatchObject({ open: true, reason: "MANUAL", closesAt: until });
    expect(serviceStateAt(s, until!, 1)).toMatchObject({ open: false, reason: "SCHEDULE" });
  });

  it("Open now during open hours ends at today's closing", () => {
    expect(overrideEnd(w, "OPEN", at(`${TUE}T10:00`))).toEqual(at(`${TUE}T17:00`));
  });

  it("lasts until changed when the schedule has no change ahead", () => {
    const closed: WeeklySchedule = Array.from({ length: 7 }, () => null);
    expect(overrideEnd(closed, "CLOSED", at(`${TUE}T10:00`))).toBeNull();
    expect(overrideEnd(closed, "OPEN", at(`${TUE}T10:00`))).toBeNull();
    const s = settings({ weekly: closed, override: { mode: "OPEN", until: null } });
    expect(serviceStateAt(s, at("2026-12-30T10:00"), 1)).toMatchObject({ open: true, reason: "MANUAL", closesAt: null });
  });
});

describe("no drivers online", () => {
  const ten = at(`${TUE}T10:00`);

  it("blocks requests in open hours when the switch is on", () => {
    expect(serviceStateAt(settings(), ten, 0)).toMatchObject({
      open: false,
      reason: "NO_DRIVERS",
      nextOpenAt: null,
      closesAt: at(`${TUE}T17:00`),
    });
    expect(serviceStateAt(settings(), ten, 1)).toMatchObject({ open: true, reason: "SCHEDULE" });
  });

  it("doesn't when the switch is off", () => {
    expect(serviceStateAt(settings({ blockWhenNoDrivers: false }), ten, 0).open).toBe(true);
  });

  it("applies to manual opening too, and closed hours stay closed hours", () => {
    const open = settings({ override: { mode: "OPEN", until: null } });
    expect(serviceStateAt(open, at(`${TUE}T22:00`), 0).reason).toBe("NO_DRIVERS");
    expect(serviceStateAt(settings(), at(`${TUE}T22:00`), 0).reason).toBe("SCHEDULE");
  });
});

describe("words", () => {
  const now = at(`${TUE}T18:00`);

  it("says when CampusRide is back, the way old app builds show the server's error", () => {
    const state = serviceStateAt(settings(), now, 2);
    expect(serviceClosedText(state, now)).toBe("CampusRide is closed. We're back at 8:00 AM tomorrow.");
    const early = at(`${TUE}T06:00`);
    expect(serviceClosedText(serviceStateAt(settings(), early, 2), early)).toBe(
      "CampusRide is closed. We're back at 8:00 AM.",
    );
    const weekend = settings({ weekly: weekly({ 6: null, 0: null }), closedMessage: "Closed for the holiday" });
    const friday = at("2026-11-27T18:00");
    expect(serviceClosedText(serviceStateAt(weekend, friday, 2), friday)).toBe(
      "Closed for the holiday. We're back on Monday at 8:00 AM.",
    );
    expect(serviceClosedText(serviceStateAt(settings(), at(`${TUE}T10:00`), 0), now)).toBe(NO_DRIVERS_TEXT);
    const never = settings({ weekly: Array.from({ length: 7 }, () => null) });
    expect(serviceClosedText(serviceStateAt(never, now, 2), now)).toBe(
      "CampusRide is closed right now. Please check back later.",
    );
  });

  it("gives the admin site one line for the state in force", () => {
    expect(serviceStateLine(serviceStateAt(settings(), at(`${TUE}T10:00`), 1), at(`${TUE}T10:00`))).toBe(
      "Open – closes at 5:00 PM",
    );
    expect(serviceStateLine(serviceStateAt(settings(), now, 1), now)).toBe("Closed – opens tomorrow at 8:00 AM");
    const manual = settings({ override: { mode: "CLOSED", until: at("2026-11-25T08:00") } });
    expect(serviceStateLine(serviceStateAt(manual, at(`${TUE}T15:00`), 1), at(`${TUE}T15:00`))).toBe(
      "Closed (manual) until tomorrow at 8:00 AM",
    );
    const opened = settings({ override: { mode: "OPEN", until: at("2026-11-25T17:00") } });
    expect(serviceStateLine(serviceStateAt(opened, now, 1), now)).toBe("Open (manual) until tomorrow at 5:00 PM");
  });
});

describe("on a phone", () => {
  function held(now: Date, over: Partial<ServiceSettings> = {}, drivers = 2, extra: Record<string, unknown> = {}) {
    const status = serviceStatusFromState(serviceStateAt(settings(over), now, drivers), now);
    return holdServiceStatus({ ...status, ...extra }, now.getTime());
  }

  it("shows the closed banner with the time CampusRide is back", () => {
    const now = at(`${TUE}T18:00`);
    expect(serviceViewAt(held(now), now.getTime())).toEqual({
      kind: "closed",
      title: "CampusRide is closed.",
      detail: "We're back at 8:00 AM tomorrow.",
      nextOpenAt: at("2026-11-25T08:00"),
    });
    expect(serviceViewAt(held(now, { closedMessage: "Closed for the holiday" }), now.getTime())).toMatchObject({
      title: "Closed for the holiday.",
    });
  });

  it("says 'Closes at 5:00 PM' only in the last 30 minutes", () => {
    const early = at(`${TUE}T16:29`);
    expect(serviceViewAt(held(early), early.getTime())).toEqual({ kind: "open", closingSoon: null });
    const late = at(`${TUE}T16:30`);
    expect(serviceViewAt(held(late), late.getTime())).toEqual({ kind: "open", closingSoon: "Closes at 5:00 PM" });
  });

  it("closes at closing time by itself, on the server's clock even when the phone's is wrong", () => {
    const serverNow = at(`${TUE}T16:50`);
    const phoneNow = serverNow.getTime() + 3 * 3600_000; // phone thinks it's 19:50
    const status = serviceStatusFromState(serviceStateAt(settings(), serverNow, 2), serverNow);
    const h = holdServiceStatus(status, phoneNow);
    expect(serviceViewAt(h, phoneNow)).toEqual({ kind: "open", closingSoon: "Closes at 5:00 PM" });
    expect(serviceViewAt(h, phoneNow + 10 * MINUTE).kind).toBe("closed");
  });

  it("shows the no-drivers line", () => {
    const now = at(`${TUE}T10:00`);
    expect(serviceViewAt(held(now, {}, 0), now.getTime())).toEqual({ kind: "noDrivers", title: NO_DRIVERS_TEXT });
  });

  it("never blocks exempt accounts (store review demo, admins)", () => {
    const now = at(`${TUE}T22:00`);
    expect(serviceViewAt(held(now, {}, 0, { exempt: true }), now.getTime())).toEqual({ kind: "open", closingSoon: null });
  });

  it("treats an unreadable answer as no banner", () => {
    expect(readServiceStatus(null)).toBeNull();
    expect(readServiceStatus({ open: "yes" })).toBeNull();
    expect(readServiceStatus({ open: false, reason: "SCHEDULE", nextOpenAt: "never" })).toBeNull();
    expect(serviceViewAt(holdServiceStatus({ open: false, reason: "LUNCH" }, 0), 0)).toEqual({
      kind: "open",
      closingSoon: null,
    });
  });

  it("gives the driver app today's hours and whether riders can book", () => {
    const closed = at(`${TUE}T18:00`);
    expect(driverServiceNotice(held(closed), closed.getTime())).toEqual({
      hours: "Service hours 8:00 AM – 5:00 PM",
      blocked: "Riders can't book right now.",
    });
    const open = at(`${TUE}T10:00`);
    expect(driverServiceNotice(held(open), open.getTime())).toEqual({
      hours: "Service hours 8:00 AM – 5:00 PM",
      blocked: null,
    });
    expect(driverServiceNotice(held(open, { weekly: weekly({ 2: null }) }), open.getTime())?.hours).toBe(
      "No service hours today",
    );
  });
});
