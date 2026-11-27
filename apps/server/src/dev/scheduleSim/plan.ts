import type { ScheduleSlotView } from "@rida/shared";

/**
 * What `npm run staging:fake-schedule` books (pure, so it can be tested):
 * three cars in three different slots, so every dispatch path shows on
 * staging —
 *   - 3 riders × 1 seat: a 3-seat car, offered to drivers at once;
 *   - 2 riders × 1 seat: a 2-seat car, offered 30 minutes before;
 *   - 1 rider: a 1-seat car, a live request 20 minutes before.
 * The slots are the first bookable ones at least `fromMinutes` away, each at
 * least `gapMinutes` after the last (so one driver can take two of them).
 */
export const FAKE_CARS = [3, 2, 1] as const;

export interface FakeCarPlan {
  arriveBy: string;
  riders: number;
}

export function planFakeSchedule(slots: readonly ScheduleSlotView[], now: number, fromMinutes = 40, gapMinutes = 30): FakeCarPlan[] {
  const out: FakeCarPlan[] = [];
  let earliest = now + fromMinutes * 60_000;
  for (const s of [...slots].sort((a, b) => a.arriveBy.localeCompare(b.arriveBy))) {
    if (out.length === FAKE_CARS.length) break;
    const at = Date.parse(s.arriveBy);
    if (!s.bookable || at < earliest) continue;
    out.push({ arriveBy: s.arriveBy, riders: FAKE_CARS[out.length]! });
    earliest = at + gapMinutes * 60_000;
  }
  return out;
}
