import { describe, expect, it } from "vitest";
import { encodePolyline } from "../geo/polyline";
import { STOP_DWELL_SECONDS, indexRoutes, straightLineSeconds } from "../geo/tripRoute";
import {
  MAX_ONBOARD_DELAY_SECONDS,
  addRiderPreviewLabel,
  onboardAddNotice,
  previewAddRider,
  previewPassengerId,
} from "./addRiderPreview";
import type { TripPassenger, TripZone } from "./tripStops";

// Five zones on a north–south line, ~110 m apart: A B C D E.
const Z = (id: string, i: number): TripZone => ({ id, name: `Zone ${id}`, latitude: 5.65 + i * 0.001, longitude: -0.186 });
const [A, B, C, D, E] = [Z("A", 0), Z("B", 1), Z("C", 2), Z("D", 3), Z("E", 4)] as const;
const zones = [A, B, C, D, E];
const noRoutes = indexRoutes([]);
const at = (z: TripZone) => ({ latitude: z.latitude, longitude: z.longitude });

const rider = (id: string, from: TripZone, to: TripZone, status: TripPassenger["status"] = "WAITING"): TripPassenger => ({
  id,
  riderName: `${id} Mensah`,
  riderPhone: null,
  pickupZoneId: from.id,
  dropoffZoneId: to.id,
  lockedFare: 500,
  status,
});

const candidate = (from: TripZone, to: TripZone) => ({ requestRideId: "req1", pickupZoneId: from.id, dropoffZoneId: to.id, farePesewas: 500 });
const order = (p: ReturnType<typeof previewAddRider>) => p!.stops.map((s) => `${s.isNew ? "new" : s.passengerId}:${s.kind}@${s.zone.id}`);

describe("where a new rider slots into the trip", () => {
  it("a rider on the way is picked up and dropped between the existing stops", () => {
    const p = previewAddRider({ passengers: [rider("ama", A, D)], candidate: candidate(B, C), zones, routes: noRoutes, from: at(A) });
    expect(order(p)).toEqual(["ama:PICKUP@A", "new:PICKUP@B", "new:DROPOFF@C", "ama:DROPOFF@D"]);
    expect(p).toMatchObject({ pickupIndex: 1, dropoffIndex: 2 });
    expect(p!.stops.filter((s) => s.isNew).every((s) => s.passengerId === previewPassengerId("req1"))).toBe(true);
  });

  it("a rider going the other way is fitted in after the current riders", () => {
    const p = previewAddRider({ passengers: [rider("ama", A, C)], candidate: candidate(E, A), zones, routes: noRoutes, from: at(A) });
    expect(order(p)).toEqual(["ama:PICKUP@A", "ama:DROPOFF@C", "new:PICKUP@E", "new:DROPOFF@A"]);
    expect(p).toMatchObject({ pickupIndex: 2, dropoffIndex: 3 });
  });

  it("never drops the new rider off before picking them up", () => {
    const p = previewAddRider({ passengers: [rider("ama", A, E)], candidate: candidate(D, B), zones, routes: noRoutes, from: at(A) });
    expect(p!.dropoffIndex).toBeGreaterThan(p!.pickupIndex);
    expect(order(p)).toEqual(["ama:PICKUP@A", "new:PICKUP@D", "ama:DROPOFF@E", "new:DROPOFF@B"]);
  });

  it("keeps a pickup the driver is already at first, even if the new rider is closer", () => {
    const p = previewAddRider({
      passengers: [rider("yaw", C, E, "ARRIVED"), rider("ama", A, D, "PICKED_UP")],
      candidate: candidate(A, B),
      zones,
      routes: noRoutes,
      from: at(A),
    });
    expect(order(p)[0]).toBe("yaw:PICKUP@C");
  });

  it("leaves riders already in the car with only their drop-off", () => {
    const p = previewAddRider({ passengers: [rider("ama", A, E, "PICKED_UP")], candidate: candidate(B, C), zones, routes: noRoutes, from: at(B) });
    expect(order(p)).toEqual(["new:PICKUP@B", "new:DROPOFF@C", "ama:DROPOFF@E"]);
  });

  it("returns null for a zone it doesn't know", () => {
    expect(
      previewAddRider({ passengers: [], candidate: { ...candidate(A, B), dropoffZoneId: "nowhere" }, zones, routes: noRoutes, from: null }),
    ).toBeNull();
  });
});

describe("the time a new rider adds", () => {
  it("is just the two extra stops when the rider is exactly on the way", () => {
    const p = previewAddRider({ passengers: [rider("ama", A, D)], candidate: candidate(B, C), zones, routes: noRoutes, from: at(A) })!;
    expect(p.addedSeconds).toBeCloseTo(2 * STOP_DWELL_SECONDS, 3);
    expect(p.addedMinutes).toBe(2); // 90 s rounds to 2
  });

  it("includes the detour for a rider going the other way", () => {
    const p = previewAddRider({ passengers: [rider("ama", A, C)], candidate: candidate(E, A), zones, routes: noRoutes, from: at(A) })!;
    const detour = straightLineSeconds(C, E) + straightLineSeconds(E, A);
    expect(p.addedSeconds).toBeCloseTo(detour + 2 * STOP_DWELL_SECONDS, 3);
    expect(p.proposedSeconds - p.currentSeconds).toBeCloseTo(p.addedSeconds, 6);
  });

  it("uses the stored road times between zones", () => {
    // The road from B to C is a long way round: 5 minutes.
    const routes = indexRoutes([
      { fromZoneId: "B", toZoneId: "C", polyline: encodePolyline([at(B), { latitude: 5.6515, longitude: -0.19 }, at(C)]), durationSeconds: 300 },
    ]);
    const p = previewAddRider({ passengers: [rider("ama", A, D)], candidate: candidate(B, C), zones, routes, from: at(A) })!;
    const before = straightLineSeconds(A, D);
    const after = straightLineSeconds(A, B) + 300 + straightLineSeconds(C, D);
    expect(p.addedSeconds).toBeCloseTo(after - before + 2 * STOP_DWELL_SECONDS, 3);
    // …and the proposed line follows that road.
    expect(p.proposedPath.some((pt) => pt.longitude === -0.19)).toBe(true);
    expect(p.currentPath.some((pt) => pt.longitude === -0.19)).toBe(false);
  });

  it("is never below a minute on the label", () => {
    expect(addRiderPreviewLabel(1, "GH₵5")).toBe("+1 rider · adds ~1 min · +GH₵5");
  });
});

describe("the detour limit for riders already in the car", () => {
  it("measures how much later each on-board rider is dropped off", () => {
    // Ama is in the car going A→C; the new rider is on the way (A→B).
    const p = previewAddRider({ passengers: [rider("ama", A, C, "PICKED_UP")], candidate: candidate(A, B), zones, routes: noRoutes, from: at(A) })!;
    // The new pickup (same spot) and drop-off (on the way) cost Ama two stops' dwell.
    expect(p.onboardDelaySeconds.ama).toBeCloseTo(2 * STOP_DWELL_SECONDS, 3);
    expect(p.withinDetourLimit).toBe(true);
    expect(onboardAddNotice(p.onboardDelaySeconds.ama!)).toBe("Picking up 1 more rider on the way · ~2 min");
  });

  it("refuses a rider whose detour would make an on-board rider more than 5 minutes late", () => {
    // Ama (in the car, A→B) would be taken on a 6-minute detour first.
    const detour = indexRoutes([
      { fromZoneId: "A", toZoneId: "C", polyline: encodePolyline([at(A), at(C)]), durationSeconds: 360 },
    ]);
    const p = previewAddRider({
      passengers: [rider("ama", A, E, "PICKED_UP")],
      candidate: candidate(C, D),
      zones,
      routes: detour,
      from: at(A),
    })!;
    expect(p.maxOnboardDelaySeconds).toBeGreaterThan(MAX_ONBOARD_DELAY_SECONDS);
    expect(p.withinDetourLimit).toBe(false);
  });

  it("has no limit to apply when nobody is in the car yet", () => {
    const p = previewAddRider({ passengers: [rider("ama", A, D)], candidate: candidate(E, A), zones, routes: noRoutes, from: at(A) })!;
    expect(p.onboardDelaySeconds).toEqual({});
    expect(p).toMatchObject({ maxOnboardDelaySeconds: 0, withinDetourLimit: true });
  });
});
