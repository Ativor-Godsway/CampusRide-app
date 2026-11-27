import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE_SETTINGS, SCHEDULE_SETTING_FIELDS, scheduleSettingsProblem } from "@rida/shared";
import { CAR_STATUS_WORDS, carRows } from "./Scheduled";
import { scheduleValues } from "../screens/ScheduleSettingsCard";

describe("admin: scheduled rides", () => {
  it("lists every car of the day in slot order, with its slot", () => {
    const car = (id: string) => ({ id, status: "OPEN" as const, seats: 2, bookings: 2, cancelled: 0, noShows: 0, driverName: null, acceptedVia: null, offeredAt: null, leaveBy: null, liveReason: null, rideId: null });
    const rows = carRows({
      day: "2026-11-27",
      totals: {} as never,
      slots: [
        { arriveBy: "2026-11-27T09:00:00.000Z", cars: [car("a"), car("b")] },
        { arriveBy: "2026-11-27T09:30:00.000Z", cars: [car("c")] },
      ],
      recent: [],
    });
    expect(rows.map((r) => [r.id, r.arriveBy.slice(11, 16)])).toEqual([
      ["a", "09:00"],
      ["b", "09:00"],
      ["c", "09:30"],
    ]);
    expect(CAR_STATUS_WORDS.LIVE).toBe("Converted to live");
  });

  it("the settings form reads typed numbers, and anything else stops Save", () => {
    const inputs = Object.fromEntries(SCHEDULE_SETTING_FIELDS.map((f) => [f.key, String(DEFAULT_SCHEDULE_SETTINGS[f.key])]));
    expect(scheduleValues(true, true, inputs)).toEqual(DEFAULT_SCHEDULE_SETTINGS);
    expect(scheduleSettingsProblem(scheduleValues(true, false, { ...inputs, slotMinutes: "ten" }))).not.toBeNull();
  });
});
