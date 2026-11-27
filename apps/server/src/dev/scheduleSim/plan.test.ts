import { describe, expect, it } from "vitest";
import { planFakeSchedule } from "./plan";

const at = (m: number) => new Date(Date.UTC(2031, 0, 6, 8) + m * 60_000).toISOString();
const slots = Array.from({ length: 30 }, (_, i) => ({ arriveBy: at(i * 10), bookable: i !== 5, going: 0, join: null }));

describe("fake schedule plan", () => {
  it("3, 2 and 1 riders in three slots from 40 min on, 30 min apart, skipping closed ones", () => {
    const now = Date.parse(at(0));
    expect(planFakeSchedule(slots, now)).toEqual([
      { arriveBy: at(40), riders: 3 },
      { arriveBy: at(70), riders: 2 },
      { arriveBy: at(100), riders: 1 },
    ]);
    expect(planFakeSchedule(slots, now, 45)[0]!.arriveBy).toBe(at(60));
  });
  it("fewer slots: fewer cars", () => {
    expect(planFakeSchedule(slots.slice(0, 8), Date.parse(at(0)))).toHaveLength(2);
  });
});
