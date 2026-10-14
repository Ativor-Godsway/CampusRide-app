import { describe, expect, it } from "vitest";
import {
  ARRIVING_MIN_AFTER_JOIN_MS,
  passengersToAlertArriving,
  type ArrivingCandidate,
} from "./arriving";

// Balme Library, and points roughly 200 m and 1 km north of it.
const PICKUP = { latitude: 5.6505, longitude: -0.1869 };
const NEAR = { latitude: 5.6523, longitude: -0.1869 };
const FAR = { latitude: 5.6595, longitude: -0.1869 };
const NOW = new Date("2026-10-15T10:00:00Z");

function passenger(overrides: Partial<ArrivingCandidate> = {}): ArrivingCandidate {
  return {
    id: "p1",
    riderId: "r1",
    status: "WAITING",
    joinedAt: new Date(NOW.getTime() - 5 * 60_000),
    pickup: PICKUP,
    ...overrides,
  };
}

describe("passengersToAlertArriving", () => {
  it("alerts a waiting rider once the driver is close", () => {
    expect(passengersToAlertArriving(NEAR, [passenger()], NOW).map((p) => p.id)).toEqual(["p1"]);
  });

  it("does not alert while the driver is far away", () => {
    expect(passengersToAlertArriving(FAR, [passenger()], NOW)).toEqual([]);
  });

  it("only alerts riders still waiting to be picked up", () => {
    for (const status of ["ARRIVED", "PICKED_UP", "DROPPED_OFF", "CANCELLED"]) {
      expect(passengersToAlertArriving(NEAR, [passenger({ status })], NOW), status).toEqual([]);
    }
  });

  it("stays quiet just after the match, so it doesn't arrive with 'on the way'", () => {
    const justJoined = passenger({
      joinedAt: new Date(NOW.getTime() - ARRIVING_MIN_AFTER_JOIN_MS + 1_000),
    });
    expect(passengersToAlertArriving(NEAR, [justJoined], NOW)).toEqual([]);
  });

  it("skips a rider whose pickup is unknown", () => {
    expect(passengersToAlertArriving(NEAR, [passenger({ pickup: null })], NOW)).toEqual([]);
  });

  it("handles several riders in a shared car independently", () => {
    const riders = [
      passenger({ id: "near", riderId: "a" }),
      passenger({ id: "far", riderId: "b", pickup: FAR }),
      passenger({ id: "aboard", riderId: "c", status: "PICKED_UP" }),
    ];
    expect(passengersToAlertArriving(NEAR, riders, NOW).map((p) => p.id)).toEqual(["near"]);
  });
});
