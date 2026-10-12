import { describe, expect, it } from "vitest";
import { haversineDistanceMeters, isInServiceArea } from "@rida/shared";
import {
  MIN_SIM_TRIP_METERS,
  SIM_PICKUP_NOTES,
  nudge,
  pickDropoffPlace,
  pickPickupNote,
  pickPickupPlace,
  planEnd,
} from "./planner";

/** A repeatable "random" sequence. */
function seq(...values: number[]) {
  let i = 0;
  return () => values[i++ % values.length]!;
}

const places = [
  { id: "balme", name: "Balme Library", latitude: 5.652012, longitude: -0.187048 },
  { id: "volta", name: "Volta Hall", latitude: 5.651496, longitude: -0.189693 },
  { id: "night", name: "Night Market", latitude: 5.642503, longitude: -0.186282 },
  { id: "ugmc", name: "UG Medical Centre", latitude: 5.631864, longitude: -0.185925 },
  { id: "tf", name: "TF Hall", latitude: 5.666259, longitude: -0.182087 },
];

describe("simulator: campus places and exact pins", () => {
  it("picks the pickup among places near the driver", () => {
    const nearBalme = { latitude: 5.652, longitude: -0.187 };
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const p = pickPickupPlace(nearBalme, places.slice(0, 2), seq(r));
      expect(["balme", "volta"]).toContain(p.id);
    }
  });

  it("sends the rider at least 300 m away", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const d = pickDropoffPlace(places, places[0]!, seq(r));
      expect(d.id).not.toBe("balme");
      expect(haversineDistanceMeters(d, places[0]!)).toBeGreaterThanOrEqual(MIN_SIM_TRIP_METERS);
    }
  });

  it("gives an end as the place, a nudged place pin, or a dropped pin — as the rider app does", () => {
    expect(planEnd(places[0]!, seq(0.1)).body).toEqual({ placeId: "balme" });
    const moved = planEnd(places[0]!, seq(0.6, 1, 0.25));
    expect(moved.body).toMatchObject({ placeId: "balme" });
    expect(haversineDistanceMeters(places[0]!, moved.body as { latitude: number; longitude: number })).toBeLessThanOrEqual(40.5);
    const dropped = planEnd(places[0]!, seq(0.9, 1, 0.5));
    expect(dropped.body).not.toHaveProperty("placeId");
    expect(dropped.description).toMatch(/^near Balme Library/);
  });

  it("nudges stay close and on campus", () => {
    for (const r of [0, 0.4, 0.8, 0.99]) {
      const p = nudge(places[2]!, 80, seq(r, r));
      expect(haversineDistanceMeters(places[2]!, p)).toBeLessThanOrEqual(80.5);
      expect(isInServiceArea(p)).toBe(true);
    }
  });

  it("adds a note for the driver about a third of the time", () => {
    expect(pickPickupNote(seq(0.1, 0))).toBe(SIM_PICKUP_NOTES[0]);
    expect(pickPickupNote(seq(0.9))).toBeNull();
  });
});
