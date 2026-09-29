import { describe, it, expect } from "vitest";
import { activeRideStatusLine, rideLeaveBehaviour } from "./activeRideStatus";

describe("activeRideStatusLine", () => {
  it("says what the ride is really doing", () => {
    expect(
      activeRideStatusLine({ status: "REQUESTED", type: "SHARED", legStatus: "WAITING" }),
    ).toBe("Finding your driver…");
    expect(
      activeRideStatusLine({
        status: "AWAITING_RIDER_DECISION",
        type: "LONE",
        legStatus: "WAITING",
      }),
    ).toBe("No drivers yet — tap to choose");
  });

  it("names the driver and their ETA once matched", () => {
    const base = {
      status: "MATCHED",
      type: "LONE",
      legStatus: "WAITING",
      driverFirstName: "Kofi",
    } as const;
    expect(activeRideStatusLine({ ...base, etaMinutes: 2.6 })).toBe("Kofi is 3 min away");
    expect(activeRideStatusLine({ ...base, etaMinutes: 0.2 })).toBe("Kofi is 1 min away");
    expect(activeRideStatusLine({ ...base, etaMinutes: null })).toBe("Kofi is on the way");
    expect(activeRideStatusLine({ ...base, driverFirstName: null })).toBe(
      "Your driver is on the way",
    );
  });

  it("uses the ride status for LONE rides (their seat row never changes)", () => {
    expect(
      activeRideStatusLine({
        status: "ARRIVED",
        type: "LONE",
        legStatus: "WAITING",
        driverFirstName: "Ama",
      }),
    ).toBe("Ama has arrived");
    expect(
      activeRideStatusLine({ status: "IN_PROGRESS", type: "LONE", legStatus: "WAITING" }),
    ).toBe("On your trip");
  });

  it("uses the rider's own seat for SHARED rides", () => {
    // Car already moving, this rider not picked up yet.
    expect(
      activeRideStatusLine({
        status: "IN_PROGRESS",
        type: "SHARED",
        legStatus: "WAITING",
        driverFirstName: "Kofi",
      }),
    ).toBe("Kofi is on the way");
    expect(
      activeRideStatusLine({ status: "IN_PROGRESS", type: "SHARED", legStatus: "PICKED_UP" }),
    ).toBe("On your trip");
    expect(
      activeRideStatusLine({ status: "IN_PROGRESS", type: "SHARED", legStatus: "DROPPED_OFF" }),
    ).toBe("You've arrived — tap for your fare");
  });
});

describe("rideLeaveBehaviour", () => {
  it.each(["REQUESTED", "AWAITING_RIDER_DECISION", "MATCHED", "ARRIVED"] as const)(
    "asks before leaving a %s ride",
    (status) => {
      expect(rideLeaveBehaviour({ status, type: "SHARED", legStatus: "WAITING" })).toBe("confirm");
    },
  );

  it("minimises during the trip instead", () => {
    expect(rideLeaveBehaviour({ status: "IN_PROGRESS", type: "LONE", legStatus: "WAITING" })).toBe(
      "minimise",
    );
    expect(rideLeaveBehaviour({ status: "ARRIVED", type: "SHARED", legStatus: "PICKED_UP" })).toBe(
      "minimise",
    );
    // SHARED car already moving: the ride can't be cancelled any more.
    expect(
      rideLeaveBehaviour({ status: "IN_PROGRESS", type: "SHARED", legStatus: "WAITING" }),
    ).toBe("minimise");
  });

  it("lets the rider leave when nothing is going on", () => {
    expect(rideLeaveBehaviour({ status: null, type: "SHARED", legStatus: null })).toBe("leave");
    expect(rideLeaveBehaviour({ status: "COMPLETED", type: "LONE", legStatus: "WAITING" })).toBe(
      "leave",
    );
    expect(rideLeaveBehaviour({ status: "CANCELLED", type: "LONE", legStatus: "WAITING" })).toBe(
      "leave",
    );
    // The driver cancelled this rider's seat.
    expect(rideLeaveBehaviour({ status: "MATCHED", type: "SHARED", legStatus: "CANCELLED" })).toBe(
      "leave",
    );
  });
});
