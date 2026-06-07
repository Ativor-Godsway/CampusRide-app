import { describe, it, expect } from "vitest";
import type { PassengerStatus, RideStatus } from "@rida/shared";
import {
  RIDE_TRANSITIONS,
  PASSENGER_TRANSITIONS,
  canTransitionRide,
  canTransitionPassenger,
  transitionRide,
  transitionPassenger,
  isActivePassengerStatus,
} from "./stateMachine";
import { InvalidTransitionError } from "./errors";

const ALL_RIDE_STATUSES: RideStatus[] = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "AWAITING_RIDER_DECISION",
];

const ALL_PASSENGER_STATUSES: PassengerStatus[] = [
  "WAITING",
  "PICKED_UP",
  "DROPPED_OFF",
  "CANCELLED",
];

// ─── Ride transitions ────────────────────────────────────────────────────────

describe("Ride state machine — legal transitions", () => {
  it("REQUESTED -> MATCHED succeeds", () => {
    const result = transitionRide({ status: "REQUESTED" }, "MATCHED");
    expect(result).toEqual({ status: "MATCHED", cancelReason: null });
  });

  it("REQUESTED -> CANCELLED succeeds with cancelReason", () => {
    const result = transitionRide(
      { status: "REQUESTED" },
      "CANCELLED",
      { cancelReason: "NO_DRIVERS_AVAILABLE" },
    );
    expect(result).toEqual({
      status: "CANCELLED",
      cancelReason: "NO_DRIVERS_AVAILABLE",
    });
  });

  it("MATCHED -> ARRIVED succeeds", () => {
    const result = transitionRide({ status: "MATCHED" }, "ARRIVED");
    expect(result).toEqual({ status: "ARRIVED", cancelReason: null });
  });

  it("MATCHED -> REQUESTED succeeds (driver backout)", () => {
    const result = transitionRide({ status: "MATCHED" }, "REQUESTED");
    expect(result).toEqual({ status: "REQUESTED", cancelReason: null });
  });

  it("MATCHED -> CANCELLED succeeds with cancelReason", () => {
    const result = transitionRide(
      { status: "MATCHED" },
      "CANCELLED",
      { cancelReason: "DRIVER_BACKED_OUT" },
    );
    expect(result.status).toBe("CANCELLED");
    expect(result.cancelReason).toBe("DRIVER_BACKED_OUT");
  });

  it("ARRIVED -> IN_PROGRESS succeeds (departure, point of no return)", () => {
    const result = transitionRide({ status: "ARRIVED" }, "IN_PROGRESS");
    expect(result).toEqual({ status: "IN_PROGRESS", cancelReason: null });
  });

  it("ARRIVED -> CANCELLED succeeds with cancelReason", () => {
    const result = transitionRide(
      { status: "ARRIVED" },
      "CANCELLED",
      { cancelReason: "RIDER_CANCELLED" },
    );
    expect(result.status).toBe("CANCELLED");
    expect(result.cancelReason).toBe("RIDER_CANCELLED");
  });

  it("IN_PROGRESS -> COMPLETED succeeds (only forward transition)", () => {
    const result = transitionRide({ status: "IN_PROGRESS" }, "COMPLETED");
    expect(result).toEqual({ status: "COMPLETED", cancelReason: null });
  });

  it("REQUESTED -> AWAITING_RIDER_DECISION succeeds (90s broadcast timeout)", () => {
    const result = transitionRide({ status: "REQUESTED" }, "AWAITING_RIDER_DECISION");
    expect(result).toEqual({ status: "AWAITING_RIDER_DECISION", cancelReason: null });
  });

  it("AWAITING_RIDER_DECISION -> REQUESTED succeeds (keep waiting / switch to lone)", () => {
    const result = transitionRide({ status: "AWAITING_RIDER_DECISION" }, "REQUESTED");
    expect(result).toEqual({ status: "REQUESTED", cancelReason: null });
  });

  it("AWAITING_RIDER_DECISION -> CANCELLED succeeds with cancelReason", () => {
    const result = transitionRide(
      { status: "AWAITING_RIDER_DECISION" },
      "CANCELLED",
      { cancelReason: "NO_DRIVERS_AVAILABLE" },
    );
    expect(result).toEqual({ status: "CANCELLED", cancelReason: "NO_DRIVERS_AVAILABLE" });
  });
});

describe("Ride state machine — illegal transitions throw InvalidTransitionError", () => {
  it("REQUESTED -> ARRIVED is illegal", () => {
    expect(() => transitionRide({ status: "REQUESTED" }, "ARRIVED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("REQUESTED -> IN_PROGRESS is illegal", () => {
    expect(() => transitionRide({ status: "REQUESTED" }, "IN_PROGRESS")).toThrow(
      InvalidTransitionError,
    );
  });

  it("REQUESTED -> COMPLETED is illegal", () => {
    expect(() => transitionRide({ status: "REQUESTED" }, "COMPLETED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("MATCHED -> IN_PROGRESS is illegal (must pass through ARRIVED)", () => {
    expect(() => transitionRide({ status: "MATCHED" }, "IN_PROGRESS")).toThrow(
      InvalidTransitionError,
    );
  });

  it("ARRIVED -> REQUESTED is illegal", () => {
    expect(() => transitionRide({ status: "ARRIVED" }, "REQUESTED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("ARRIVED -> MATCHED is illegal", () => {
    expect(() => transitionRide({ status: "ARRIVED" }, "MATCHED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("IN_PROGRESS -> only COMPLETED is allowed; everything else throws", () => {
    for (const to of ALL_RIDE_STATUSES) {
      if (to === "COMPLETED") continue;
      expect(() => transitionRide({ status: "IN_PROGRESS" }, to)).toThrow(
        InvalidTransitionError,
      );
    }
  });

  it("IN_PROGRESS -> CANCELLED is illegal (point of no return)", () => {
    expect(() =>
      transitionRide({ status: "IN_PROGRESS" }, "CANCELLED", {
        cancelReason: "RIDER_CANCELLED",
      }),
    ).toThrow(InvalidTransitionError);
  });

  it("COMPLETED is terminal — rejects all outgoing transitions", () => {
    for (const to of ALL_RIDE_STATUSES) {
      expect(() => transitionRide({ status: "COMPLETED" }, to)).toThrow(
        InvalidTransitionError,
      );
    }
    expect(RIDE_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it("CANCELLED is terminal — rejects all outgoing transitions", () => {
    for (const to of ALL_RIDE_STATUSES) {
      expect(() => transitionRide({ status: "CANCELLED" }, to)).toThrow(
        InvalidTransitionError,
      );
    }
    expect(RIDE_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("transitioning to CANCELLED without a cancelReason throws", () => {
    expect(() => transitionRide({ status: "REQUESTED" }, "CANCELLED")).toThrow(
      /cancelReason/,
    );
  });

  it("AWAITING_RIDER_DECISION -> MATCHED is illegal (must go through REQUESTED)", () => {
    expect(() =>
      transitionRide({ status: "AWAITING_RIDER_DECISION" }, "MATCHED"),
    ).toThrow(InvalidTransitionError);
  });

  it("AWAITING_RIDER_DECISION is not terminal but only REQUESTED/CANCELLED are legal", () => {
    expect(RIDE_TRANSITIONS.AWAITING_RIDER_DECISION).toEqual(["REQUESTED", "CANCELLED"]);
  });
});

describe("canTransitionRide", () => {
  it("agrees with transitionRide for every (from, to) pair", () => {
    for (const from of ALL_RIDE_STATUSES) {
      for (const to of ALL_RIDE_STATUSES) {
        const allowed = canTransitionRide(from, to);
        if (allowed) {
          expect(() =>
            transitionRide({ status: from }, to, {
              cancelReason: "RIDER_CANCELLED",
            }),
          ).not.toThrow();
        } else {
          expect(() =>
            transitionRide({ status: from }, to, {
              cancelReason: "RIDER_CANCELLED",
            }),
          ).toThrow(InvalidTransitionError);
        }
      }
    }
  });
});

// ─── Passenger transitions ───────────────────────────────────────────────────

describe("Passenger state machine — legal transitions", () => {
  it("WAITING -> PICKED_UP succeeds", () => {
    expect(transitionPassenger({ status: "WAITING" }, "PICKED_UP")).toEqual({
      status: "PICKED_UP",
    });
  });

  it("WAITING -> CANCELLED succeeds", () => {
    expect(transitionPassenger({ status: "WAITING" }, "CANCELLED")).toEqual({
      status: "CANCELLED",
    });
  });

  it("PICKED_UP -> DROPPED_OFF succeeds", () => {
    expect(transitionPassenger({ status: "PICKED_UP" }, "DROPPED_OFF")).toEqual({
      status: "DROPPED_OFF",
    });
  });
});

describe("Passenger state machine — illegal transitions throw InvalidTransitionError", () => {
  it("PICKED_UP -> CANCELLED is illegal", () => {
    expect(() => transitionPassenger({ status: "PICKED_UP" }, "CANCELLED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("WAITING -> DROPPED_OFF is illegal (must be picked up first)", () => {
    expect(() => transitionPassenger({ status: "WAITING" }, "DROPPED_OFF")).toThrow(
      InvalidTransitionError,
    );
  });

  it("DROPPED_OFF is terminal — rejects all outgoing transitions", () => {
    for (const to of ALL_PASSENGER_STATUSES) {
      expect(() => transitionPassenger({ status: "DROPPED_OFF" }, to)).toThrow(
        InvalidTransitionError,
      );
    }
    expect(PASSENGER_TRANSITIONS.DROPPED_OFF).toEqual([]);
  });

  it("CANCELLED is terminal — rejects all outgoing transitions", () => {
    for (const to of ALL_PASSENGER_STATUSES) {
      expect(() => transitionPassenger({ status: "CANCELLED" }, to)).toThrow(
        InvalidTransitionError,
      );
    }
    expect(PASSENGER_TRANSITIONS.CANCELLED).toEqual([]);
  });
});

describe("canTransitionPassenger", () => {
  it("agrees with transitionPassenger for every (from, to) pair", () => {
    for (const from of ALL_PASSENGER_STATUSES) {
      for (const to of ALL_PASSENGER_STATUSES) {
        const allowed = canTransitionPassenger(from, to);
        if (allowed) {
          expect(() => transitionPassenger({ status: from }, to)).not.toThrow();
        } else {
          expect(() => transitionPassenger({ status: from }, to)).toThrow(
            InvalidTransitionError,
          );
        }
      }
    }
  });
});

describe("isActivePassengerStatus", () => {
  it("WAITING and PICKED_UP count toward occupancy", () => {
    expect(isActivePassengerStatus("WAITING")).toBe(true);
    expect(isActivePassengerStatus("PICKED_UP")).toBe(true);
  });

  it("DROPPED_OFF and CANCELLED do not count toward occupancy", () => {
    expect(isActivePassengerStatus("DROPPED_OFF")).toBe(false);
    expect(isActivePassengerStatus("CANCELLED")).toBe(false);
  });
});
