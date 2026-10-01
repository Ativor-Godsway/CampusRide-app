import { describe, expect, it } from "vitest";
import {
  NO_SHOW_AFTER_MS,
  firstName,
  nextStopInstruction,
  riderName,
  riderStatusWord,
  stepToast,
  formatWait,
  isAtStop,
  noShowAvailableAt,
  planTripStops,
  seatStates,
  type TripPassenger,
  type TripZone,
} from "./tripStops";

// Zones on a north–south line, ~110 m apart.
const zone = (id: string, i: number): TripZone => ({ id, name: id, latitude: 5.65 + i * 0.001, longitude: -0.186 });
const zones = new Map([zone("A", 0), zone("B", 1), zone("C", 2), zone("D", 3), zone("E", 4)].map((z) => [z.id, z]));

const pax = (id: string, from: string, to: string, status: TripPassenger["status"] = "WAITING", extra: Partial<TripPassenger> = {}): TripPassenger => ({
  id,
  riderName: `${id} Mensah`,
  riderPhone: "+233240000000",
  pickupZoneId: from,
  dropoffZoneId: to,
  lockedFare: 500,
  status,
  ...extra,
});

const keys = (plan: ReturnType<typeof planTripStops>) => plan.upcoming.map((s) => s.key);

describe("planTripStops", () => {
  it("a Ride-alone trip is one pickup then one drop-off", () => {
    const plan = planTripStops({ passengers: [pax("ama", "A", "D")], zones, from: null });
    expect(keys(plan)).toEqual(["ama:PICKUP", "ama:DROPOFF"]);
    expect(plan).toMatchObject({ doneCount: 0, totalCount: 2 });
    expect(plan.upcoming[0]).toMatchObject({ riderFirstName: "ama", zone: { id: "A" } });
  });

  it("never drops a rider off before picking them up, even when the drop-off is nearer", () => {
    // Driver at B. Kofi's drop-off (B) is right here, but Kofi is at E.
    const plan = planTripStops({ passengers: [pax("kofi", "E", "B")], zones, from: zones.get("B")! });
    expect(keys(plan)).toEqual(["kofi:PICKUP", "kofi:DROPOFF"]);
  });

  it("goes nearest-next and picks up before dropping off at the same spot", () => {
    const plan = planTripStops({
      passengers: [pax("ama", "A", "C"), pax("yaw", "B", "E"), pax("kofi", "C", "D", "PICKED_UP")],
      zones,
      from: zones.get("A")!,
    });
    expect(keys(plan)).toEqual(["ama:PICKUP", "yaw:PICKUP", "ama:DROPOFF", "kofi:DROPOFF", "yaw:DROPOFF"]);
    expect(plan.doneCount).toBe(1); // Kofi's pickup
    expect(plan.totalCount).toBe(6);
  });

  it("keeps the pickup the driver is at first, wherever the driver is now", () => {
    const plan = planTripStops({
      passengers: [pax("ama", "A", "C"), pax("yaw", "E", "D", "ARRIVED", { arrivedAt: "2026-10-01T10:00:00Z" })],
      zones,
      from: zones.get("A")!,
    });
    expect(plan.upcoming[0]).toMatchObject({ key: "yaw:PICKUP", arrivedAt: "2026-10-01T10:00:00Z" });
  });

  it("leaves cancelled riders out and counts drop-offs as done", () => {
    const plan = planTripStops({
      passengers: [pax("ama", "A", "B", "DROPPED_OFF"), pax("gone", "C", "D", "CANCELLED"), pax("yaw", "C", "E", "PICKED_UP")],
      zones,
      from: null,
    });
    expect(keys(plan)).toEqual(["yaw:DROPOFF"]);
    expect(plan).toMatchObject({ doneCount: 3, totalCount: 4 });
  });

  it("skips a stop whose zone it doesn't know rather than crashing", () => {
    expect(keys(planTripStops({ passengers: [pax("ama", "ZZ", "A")], zones, from: null }))).toEqual(["ama:DROPOFF"]);
  });
});

describe("seatStates", () => {
  it("fills on-board seats first, then riders being collected, then free seats", () => {
    expect(seatStates([{ status: "WAITING" }, { status: "PICKED_UP" }, { status: "DROPPED_OFF" }])).toEqual([
      "onboard",
      "coming",
      "empty",
      "empty",
    ]);
  });
});

describe("stop helpers", () => {
  it("knows when the driver is at a stop", () => {
    expect(isAtStop({ latitude: 5.6503, longitude: -0.186 }, zones.get("A")!)).toBe(true); // ~33 m
    expect(isAtStop({ latitude: 5.651, longitude: -0.186 }, zones.get("A")!)).toBe(false); // ~110 m
    expect(isAtStop(null, zones.get("A")!)).toBe(false);
  });

  it("unlocks 'rider didn't show' three minutes after arrival", () => {
    expect(noShowAvailableAt("2026-10-01T10:00:00.000Z")).toBe(Date.parse("2026-10-01T10:00:00.000Z") + NO_SHOW_AFTER_MS);
    expect(noShowAvailableAt(null)).toBeNull();
    expect(NO_SHOW_AFTER_MS).toBe(180_000);
  });

  it("formats the wait and first names", () => {
    expect(formatWait(84_000)).toBe("1:24");
    expect(formatWait(-5)).toBe("0:00");
    expect(firstName("  Ama  Serwaa ")).toBe("Ama");
    expect(firstName(null)).toBe("");
  });
});

describe("plain words for the driver", () => {
  const cedis = (p: number) => `GH₵${p / 100}`;
  const ama = { kind: "PICKUP" as const, riderFirstName: "Ama", zone: { id: "B", name: "Balme Library", latitude: 0, longitude: 0 }, farePesewas: 500 };
  const kofi = { kind: "DROPOFF" as const, riderFirstName: "Kofi", zone: { id: "M", name: "Main Gate", latitude: 0, longitude: 0 }, farePesewas: 500 };

  it("says what to do at the next stop", () => {
    expect(nextStopInstruction(ama, { cash: true, formatFare: cedis })).toBe("Pick up Ama at Balme Library");
    expect(nextStopInstruction(kofi, { cash: true, formatFare: cedis })).toBe("Drop off Kofi at Main Gate · collect GH₵5");
    expect(nextStopInstruction(kofi, { cash: false, formatFare: cedis })).toBe("Drop off Kofi at Main Gate");
    expect(nextStopInstruction({ ...ama, riderFirstName: "" }, { cash: true, formatFare: cedis })).toBe("Pick up the rider at Balme Library");
  });

  it("never uses a placeholder name", () => {
    expect(riderName({ riderFirstName: "" })).toBe("Rider");
    expect(riderName({ riderFirstName: "Ama" })).toBe("Ama");
  });

  it("gives each rider's status in one word", () => {
    expect(["WAITING", "ARRIVED", "PICKED_UP", "DROPPED_OFF"].map((s) => riderStatusWord(s as never))).toEqual([
      "Waiting",
      "Arrived",
      "In car",
      "Dropped off",
    ]);
  });

  it("tells the driver what just happened and what's next", () => {
    expect(stepToast(ama, { ...kofi, kind: "PICKUP" })).toBe("Ama is in the car · next: pick up Kofi");
    expect(stepToast(kofi, { ...ama, kind: "DROPOFF" })).toBe("Kofi dropped off · next: drop off Ama");
    expect(stepToast(kofi, undefined)).toBe("Kofi dropped off · that's everyone");
    expect(stepToast(ama, { ...kofi, riderFirstName: "" })).toBe("Ama is in the car · next: drop off the rider at Main Gate");
  });
});
