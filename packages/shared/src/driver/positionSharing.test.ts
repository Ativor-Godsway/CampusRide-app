import { describe, expect, it } from "vitest";
import {
  IDLE_POSITION_EVERY_MS,
  TRIP_POSITION_EVERY_MS,
  driverLocationCadence,
  positionToSend,
  type PositionSharingState,
} from "./positionSharing";

const state = (s: Partial<PositionSharingState>): PositionSharingState => ({
  rideId: null,
  online: false,
  lastSentAt: null,
  lastSentFor: null,
  ...s,
});

describe("positionToSend", () => {
  it("sends nothing when offline with no trip", () => {
    expect(positionToSend(state({}), 0)).toBeNull();
  });

  it("online without a trip: an idle position at most every 15 s", () => {
    const s = state({ online: true });
    expect(positionToSend(s, 0)).toEqual({ kind: "idle" });
    const sent = { ...s, lastSentAt: 0, lastSentFor: "idle" };
    expect(positionToSend(sent, IDLE_POSITION_EVERY_MS - 1)).toBeNull();
    expect(positionToSend(sent, IDLE_POSITION_EVERY_MS)).toEqual({ kind: "idle" });
  });

  it("on a trip: a trip position at most every 4 s, the first at once even right after an idle one", () => {
    const s = state({ online: true, rideId: "r1", lastSentAt: 0, lastSentFor: "idle" });
    expect(positionToSend(s, 1)).toEqual({ kind: "trip", rideId: "r1" });
    const sent = { ...s, lastSentAt: 1, lastSentFor: "r1" };
    expect(positionToSend(sent, TRIP_POSITION_EVERY_MS)).toBeNull();
    expect(positionToSend(sent, TRIP_POSITION_EVERY_MS + 1)).toEqual({ kind: "trip", rideId: "r1" });
  });

  it("a trip under way is shared even if the app has the driver offline", () => {
    expect(positionToSend(state({ rideId: "r1", online: false }), 0)).toEqual({ kind: "trip", rideId: "r1" });
  });
});

describe("driverLocationCadence", () => {
  it("Android: a fix every 5 s on a trip and every 15 s otherwise, moving or not", () => {
    expect(driverLocationCadence("android", "trip")).toEqual({ timeInterval: 5_000, distanceInterval: 0 });
    expect(driverLocationCadence("android", "idle")).toEqual({ timeInterval: 15_000, distanceInterval: 0 });
  });

  it("iPhone: unchanged, the same in both modes", () => {
    expect(driverLocationCadence("ios", "trip")).toEqual({ timeInterval: 5_000, distanceInterval: 10 });
    expect(driverLocationCadence("ios", "idle")).toEqual(driverLocationCadence("ios", "trip"));
  });
});
