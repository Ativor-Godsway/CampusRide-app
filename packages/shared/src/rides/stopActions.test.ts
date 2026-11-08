import { describe, expect, it } from "vitest";
import {
  STOP_FAR_WARNING_METERS,
  UNDO_ACCEPTED_FOR_MS,
  UNDO_WINDOW_MS,
  isFarFromStop,
  markStopPrompt,
  stopMarkAction,
  undoneStatus,
} from "./stopActions";

// ~111 m per 0.001° of latitude.
const stop = { latitude: 5.65, longitude: -0.186 };
const metresNorth = (m: number) => ({ latitude: 5.65 + m / 111_195, longitude: -0.186 });

describe("what a stop can be marked as", () => {
  it("any open pickup: picked up; a drop-off only once that rider is on board", () => {
    expect(stopMarkAction({ kind: "PICKUP", passengerStatus: "WAITING" })).toBe("pickup");
    expect(stopMarkAction({ kind: "PICKUP", passengerStatus: "ARRIVED" })).toBe("pickup");
    expect(stopMarkAction({ kind: "PICKUP", passengerStatus: "PICKED_UP" })).toBeNull();
    expect(stopMarkAction({ kind: "DROPOFF", passengerStatus: "WAITING" })).toBeNull();
    expect(stopMarkAction({ kind: "DROPOFF", passengerStatus: "ARRIVED" })).toBeNull();
    expect(stopMarkAction({ kind: "DROPOFF", passengerStatus: "PICKED_UP" })).toBe("dropoff");
    expect(stopMarkAction({ kind: "DROPOFF", passengerStatus: "DROPPED_OFF" })).toBeNull();
  });
});

describe("the distance warning", () => {
  it("is 300 m, only with a position, and never blocks", () => {
    expect(STOP_FAR_WARNING_METERS).toBe(300);
    expect(isFarFromStop(metresNorth(290), stop)).toBe(false);
    expect(isFarFromStop(metresNorth(320), stop)).toBe(true);
    expect(isFarFromStop(null, stop)).toBe(false);
  });

  it("asks plainly, and says so when the driver is far", () => {
    const bill = { kind: "PICKUP" as const, riderFirstName: "Bill", point: stop };
    expect(markStopPrompt(bill, metresNorth(50))).toEqual({
      title: "Mark Bill as picked up?",
      message: undefined,
      confirmLabel: "Picked up",
      far: false,
    });
    expect(markStopPrompt(bill, metresNorth(800))).toEqual({
      title: "Mark Bill as picked up?",
      message: "You're far from Bill's pickup. Mark anyway?",
      confirmLabel: "Mark anyway",
      far: true,
    });
    expect(markStopPrompt({ ...bill, kind: "DROPOFF" }, metresNorth(800)).message).toBe(
      "You're far from Bill's drop-off. Mark anyway?",
    );
    // No GPS: no warning.
    expect(markStopPrompt({ ...bill, kind: "DROPOFF" }, null)).toMatchObject({
      title: "Mark Bill as dropped off?",
      confirmLabel: "Dropped off",
      far: false,
    });
    expect(markStopPrompt({ ...bill, riderFirstName: "" }, null).title).toBe("Mark Rider as picked up?");
  });
});

describe("undo", () => {
  it("shows for 10 s; the server allows a little longer for the undo to travel", () => {
    expect(UNDO_WINDOW_MS).toBe(10_000);
    expect(UNDO_ACCEPTED_FOR_MS).toBeGreaterThan(UNDO_WINDOW_MS);
  });

  it("puts the seat back where it was", () => {
    expect(undoneStatus("pickup")).toBe("ARRIVED");
    expect(undoneStatus("pickup", true)).toBe("WAITING");
    expect(undoneStatus("dropoff")).toBe("PICKED_UP");
  });
});
