import { describe, expect, it } from "vitest";
import {
  AUTO_ARRIVAL_DWELL_MS,
  INITIAL_ARRIVAL_STATE,
  stepArrival,
  type ArrivalSample,
  type ArrivalState,
} from "./autoArrival";

const pickup = { latitude: 5.65, longitude: -0.186 };
/** ~1 m per 0.000009° of latitude. */
const metersNorth = (m: number) => ({ latitude: pickup.latitude + m * 0.000009, longitude: pickup.longitude });

function run(samples: ArrivalSample[]): number | null {
  let state: ArrivalState = INITIAL_ARRIVAL_STATE;
  for (const s of samples) {
    const r = stepArrival(state, s, pickup);
    state = r.state;
    if (r.arrived) return s.at;
  }
  return null;
}

/** A fix every `everyMs`, moving `metersPerFix` north from `startM` each time. */
function drive(startM: number, metersPerFix: number, fixes: number, everyMs = 1_000, speed?: number | null): ArrivalSample[] {
  return Array.from({ length: fixes }, (_, i) => ({ ...metersNorth(startM + i * metersPerFix), at: i * everyMs, speed }));
}

describe("auto-arrival", () => {
  it("does NOT fire when driving straight through the pickup at 30 km/h", () => {
    expect(run(drive(-200, 8.3, 50, 1_000, 8.3))).toBeNull();
  });

  it("does NOT fire driving past when the phone reports no speed (worked out from the fixes)", () => {
    expect(run(drive(-200, 8.3, 50, 1_000, null))).toBeNull();
    expect(run(drive(-200, 8.3, 50, 1_000, -1))).toBeNull(); // iOS "unknown"
  });

  it("does NOT fire for a short stop at the pickup (8 s) before driving on", () => {
    const stop = Array.from({ length: 9 }, (_, i) => ({ ...metersNorth(10), at: i * 1_000, speed: 0 }));
    const leave = drive(30, 8, 10, 1_000, 8).map((s) => ({ ...s, at: s.at + 9_000 }));
    expect(run([...stop, ...leave])).toBeNull();
  });

  it("does NOT fire crawling past at walking pace plus a bit (3 m/s)", () => {
    expect(run(drive(-60, 3, 40, 1_000, 3))).toBeNull();
  });

  it("fires after 10 s parked inside the radius", () => {
    const parked = Array.from({ length: 15 }, (_, i) => ({ ...metersNorth(25), at: i * 1_000, speed: 0.2 }));
    expect(run(parked)).toBe(AUTO_ARRIVAL_DWELL_MS);
  });

  it("fires with sparse fixes (every 5 s) once 10 s have passed", () => {
    const parked = Array.from({ length: 4 }, (_, i) => ({ ...metersNorth(40), at: i * 5_000, speed: null }));
    expect(run(parked)).toBe(10_000);
  });

  it("restarts the 10 s if GPS jitter puts the driver outside the radius", () => {
    const samples: ArrivalSample[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ ...metersNorth(20), at: i * 1_000, speed: 0 })),
      { ...metersNorth(90), at: 8_000, speed: 0 }, // a bad fix 90 m away
      ...Array.from({ length: 11 }, (_, i) => ({ ...metersNorth(20), at: 9_000 + i * 1_000, speed: 0 })),
    ];
    expect(run(samples)).toBe(19_000);
  });

  it("never fires outside the radius however long the driver waits", () => {
    expect(run(Array.from({ length: 60 }, (_, i) => ({ ...metersNorth(75), at: i * 1_000, speed: 0 })))).toBeNull();
  });
});
