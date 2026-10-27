import { describe, expect, it } from "vitest";
import { getLoneFare, getSharedFarePerRider } from "@rida/shared";
import { paidFareTotal, paidSeats, requestFare, seatFare } from "./fares";

/**
 * A ride's money comes from the fares stored on its seats, so a price change
 * reaches only new requests: a seat booked at the old shared GH₵5 keeps it.
 */
describe("fares stored on seats", () => {
  it("a seat's fare: charged at drop-off, else locked at request, else today's price", () => {
    expect(seatFare("SHARED", { status: "DROPPED_OFF", lockedFare: 500, fareCharged: 500 })).toBe(500);
    expect(seatFare("SHARED", { status: "PICKED_UP", lockedFare: 500 })).toBe(500);
    expect(seatFare("SHARED", { status: "WAITING", lockedFare: null })).toBe(getSharedFarePerRider(1));
    expect(seatFare("LONE", { status: "WAITING", lockedFare: null })).toBe(getLoneFare());
  });

  it("a shared trip is paid for the riders dropped off, each at their own fare", () => {
    const seats = [
      { status: "DROPPED_OFF", lockedFare: 500, fareCharged: 500 },
      { status: "DROPPED_OFF", lockedFare: 700, fareCharged: 700 },
      { status: "CANCELLED", lockedFare: 500 },
    ];
    expect(paidSeats("SHARED", seats)).toHaveLength(2);
    expect(paidFareTotal("SHARED", seats)).toBe(1200);
  });

  it("a shared trip that dropped nobody off was paid nothing", () => {
    expect(paidFareTotal("SHARED", [{ status: "CANCELLED", lockedFare: 700 }])).toBe(0);
  });

  it("Ride alone is paid its one rider's fare, never marked dropped off", () => {
    expect(paidFareTotal("LONE", [{ status: "PICKED_UP", lockedFare: 1500 }])).toBe(1500);
    expect(paidFareTotal("LONE", [])).toBe(getLoneFare());
  });

  it("a request's fare is its requester's seat", () => {
    const seats = [
      { riderId: "other", status: "CANCELLED", lockedFare: 900 },
      { riderId: "ama", status: "WAITING", lockedFare: 500 },
    ];
    expect(requestFare("SHARED", seats, "ama")).toBe(500);
    expect(requestFare("SHARED", seats, "someone-else")).toBe(500); // its only active seat
    expect(requestFare("SHARED", [], "ama")).toBe(getSharedFarePerRider(1));
  });
});
