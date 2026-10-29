import { describe, expect, it } from "vitest";
import { haversineDistanceMeters } from "../geo/distance";
import {
  CURRENT_LOCATION_LABEL,
  clampToRadius,
  gpsEnd,
  gpsSubtitle,
  isSameSpot,
  movedEnd,
  pinEnd,
  pickupPlace,
  placeEnd,
  recentTripEnds,
  rideEnd,
  tripEndBody,
  tripEndFromParams,
  tripEndParams,
  tripEndProblem,
} from "./tripEnd";

const balme = { id: "balme", name: "Balme Library", latitude: 5.65201, longitude: -0.18705 };
const night = { id: "night", name: "Night Market", latitude: 5.64208, longitude: -0.1856 };
const places = [balme, night];
const zone = { id: "z1", name: "Legon Hall", latitude: 5.6494, longitude: -0.188 };

describe("trip ends", () => {
  it("a place keeps its id; a pin is labelled by the nearest place", () => {
    expect(placeEnd(balme)).toEqual({ kind: "place", latitude: 5.65201, longitude: -0.18705, label: "Balme Library", placeId: "balme" });
    expect(pinEnd({ latitude: 5.6531, longitude: -0.18705 }, places)).toMatchObject({ kind: "pin", label: "Near Balme Library", placeId: null });
  });

  it("GPS is 'Current location', with the place it's at (within 50 m)", () => {
    const at = gpsEnd({ latitude: 5.65203, longitude: -0.18706 }, places);
    expect(at).toMatchObject({ kind: "gps", label: CURRENT_LOCATION_LABEL, placeId: "balme", atPlaceName: "Balme Library" });
    expect(gpsSubtitle(at, places)).toBe("At Balme Library");
    const away = gpsEnd({ latitude: 5.66, longitude: -0.19 }, places);
    expect(away.placeId).toBeNull();
    expect(gpsSubtitle(away, places)).toBeNull();
  });

  it("refuses ends outside the campus area, in words", () => {
    expect(tripEndProblem(placeEnd(balme), "pickup")).toBeNull();
    expect(tripEndProblem({ ...placeEnd(balme), latitude: 5.62218, longitude: -0.17326 }, "dropoff")).toMatch(/outside campus/);
  });

  it("knows two ends at the same spot", () => {
    expect(isSameSpot(placeEnd(balme), pinEnd({ latitude: 5.65205, longitude: -0.18705 }, places))).toBe(true);
    expect(isSameSpot(placeEnd(balme), placeEnd(night))).toBe(false);
    expect(isSameSpot(null, placeEnd(night))).toBe(false);
  });
});

describe("Move pin to the exact spot", () => {
  it("keeps a drag within 200 m, and lands a longer one on the 200 m circle", () => {
    const near = clampToRadius(balme, { latitude: 5.6530, longitude: -0.18705 });
    expect(near.clamped).toBe(false);
    const far = clampToRadius(balme, { latitude: 5.6560, longitude: -0.18705 }); // ~440 m north
    expect(far.clamped).toBe(true);
    expect(haversineDistanceMeters(balme, far)).toBeCloseTo(200, 0);
    expect(far.latitude).toBeGreaterThan(balme.latitude);
  });

  it("a nudged place keeps its name; a GPS pickup becomes a labelled pin", () => {
    const nudged = movedEnd(placeEnd(balme), { latitude: 5.6525, longitude: -0.18705 }, places);
    expect(nudged).toMatchObject({ kind: "place", placeId: "balme", label: "Balme Library", latitude: 5.6525 });
    const moved = movedEnd(gpsEnd({ latitude: 5.6420, longitude: -0.1856 }, places), { latitude: 5.64209, longitude: -0.1856 }, places);
    expect(moved).toMatchObject({ kind: "pin", label: "Night Market" });
  });
});

describe("to the server and through route params", () => {
  it("sends the point, and the place id only for a chosen place", () => {
    expect(tripEndBody(placeEnd(balme))).toEqual({ latitude: 5.65201, longitude: -0.18705, placeId: "balme" });
    expect(tripEndBody(gpsEnd(balme, places))).toEqual({ latitude: 5.65201, longitude: -0.18705 });
  });

  it("round-trips through params", () => {
    const end = placeEnd(night);
    expect(tripEndFromParams("dropoff", tripEndParams("dropoff", end))).toEqual(end);
    expect(tripEndFromParams("pickup", {})).toBeNull();
    expect(tripEndFromParams("pickup", { pickupLat: "x", pickupLng: "1" })).toBeNull();
  });
});

describe("from a ride", () => {
  it("uses the exact pin, or the zone centre for a ride booked without one", () => {
    expect(rideEnd({ dropoffLat: 5.642, dropoffLng: -0.1856, dropoffLabel: "Night Market", dropoffPlaceId: "night" }, "dropoff", zone))
      .toMatchObject({ kind: "place", latitude: 5.642, label: "Night Market", placeId: "night" });
    expect(rideEnd({}, "pickup", zone)).toEqual({ kind: "pin", latitude: zone.latitude, longitude: zone.longitude, label: "Legon Hall", placeId: null });
  });

  it("recent destinations: newest first, each place or pin once, renamed places refreshed", () => {
    const rides = [
      { createdAt: "2026-10-01T10:00:00Z", dropoffZone: zone, dropoffLat: 5.65201, dropoffLng: -0.18705, dropoffLabel: "Balme", dropoffPlaceId: "balme" },
      { createdAt: "2026-10-03T10:00:00Z", dropoffZone: zone, dropoffLat: 5.65201, dropoffLng: -0.18705, dropoffLabel: "Balme", dropoffPlaceId: "balme" },
      { createdAt: "2026-10-02T10:00:00Z", dropoffZone: zone, dropoffLat: 5.66, dropoffLng: -0.19, dropoffLabel: "Pinned location", dropoffPlaceId: null },
      { createdAt: "2026-10-02T09:00:00Z", dropoffZone: zone, dropoffLat: 5.66001, dropoffLng: -0.19, dropoffLabel: "Pinned location", dropoffPlaceId: null },
      { createdAt: "2026-09-01T10:00:00Z", dropoffZone: zone },
    ];
    const recent = recentTripEnds(rides, places, 5);
    expect(recent.map((r) => r.label)).toEqual(["Balme Library", "Pinned location", "Legon Hall"]);
    // A place that no longer exists is still a usable pin.
    expect(recentTripEnds(rides.slice(0, 1), [night], 3)[0]).toMatchObject({ kind: "pin", placeId: null, label: "Balme" });
  });
});

describe("the pickup in a sentence", () => {
  it("names the place a GPS fix is at, never 'Current location'", () => {
    const end = gpsEnd({ latitude: 5.65203, longitude: -0.18705 }, places);
    expect(end.label).toBe(CURRENT_LOCATION_LABEL);
    expect(pickupPlace(end, places)).toEqual({ name: "Balme Library", at: true });
  });

  it("a point near a place is near it; a chosen place is at it", () => {
    expect(pickupPlace(gpsEnd({ latitude: 5.6531, longitude: -0.18705 }, places), places)).toEqual({
      name: "Balme Library",
      at: false,
    });
    expect(pickupPlace(placeEnd(night), [])).toEqual({ name: "Night Market", at: true });
  });

  it("falls back to the ride's zone, then to nothing", () => {
    const far = gpsEnd({ latitude: 5.66, longitude: -0.2 }, places);
    expect(pickupPlace(far, places, "Legon Hall")).toEqual({ name: "Legon Hall", at: false });
    expect(pickupPlace(far, places)).toBeNull();
    expect(pickupPlace(far, [], "  ")).toBeNull();
  });
});
