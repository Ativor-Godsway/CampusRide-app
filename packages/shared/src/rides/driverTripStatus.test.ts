import { describe, it, expect } from "vitest";
import { driverTripHref, driverTripStatusLine } from "./driverTripStatus";

const lone = {
  type: "LONE",
  pickupZoneName: "Main Gate",
  dropoffZoneName: "Akuafo Hall",
  passengerStatuses: [],
} as const;

describe("driverTripStatusLine", () => {
  it("follows a LONE trip's stages", () => {
    expect(driverTripStatusLine({ ...lone, status: "MATCHED" })).toBe("Head to pickup: Main Gate");
    expect(driverTripStatusLine({ ...lone, status: "ARRIVED" })).toBe(
      "Waiting for your rider at Main Gate",
    );
    expect(driverTripStatusLine({ ...lone, status: "IN_PROGRESS" })).toBe("On trip to Akuafo Hall");
  });

  it("counts only riders still in (or waiting for) a SHARED car", () => {
    const shared = { ...lone, type: "SHARED" } as const;
    expect(
      driverTripStatusLine({
        ...shared,
        status: "MATCHED",
        passengerStatuses: ["WAITING", "ARRIVED", "CANCELLED"],
      }),
    ).toBe("Filling your car · 2 riders");
    expect(
      driverTripStatusLine({
        ...shared,
        status: "IN_PROGRESS",
        passengerStatuses: ["PICKED_UP", "DROPPED_OFF"],
      }),
    ).toBe("Shared trip under way · 1 rider");
  });
});

describe("driverTripHref", () => {
  it("sends every trip, Ride alone or Shared, to the one trip screen", () => {
    expect(driverTripHref({ id: "r1" })).toBe("/ride/r1");
  });
});
