import { describe, expect, it } from "vitest";
import {
  bookingLabel,
  bookingSeats,
  carSeatsLabel,
  freeSeatsIn,
  notEnoughSeatsText,
  seatsTaken,
  seatsWithPrice,
} from "./seats";
import { seatStates } from "./tripStops";
import { offerKindLabel } from "../driver/rideOffers";

describe("seats on bookings", () => {
  it("a booking with no seat count (older apps and servers) is 1 seat", () => {
    expect(bookingSeats({})).toBe(1);
    expect(bookingSeats({ seats: null })).toBe(1);
    expect(bookingSeats({ seats: 0 })).toBe(1);
    expect(bookingSeats({ seats: 3 })).toBe(3);
  });

  it("a car holds 4 seats, not 4 bookings", () => {
    const car = [
      { status: "PICKED_UP", seats: 2 },
      { status: "WAITING", seats: 1 },
      { status: "DROPPED_OFF", seats: 3 },
      { status: "CANCELLED", seats: 2 },
    ];
    expect(seatsTaken(car)).toBe(3);
    expect(freeSeatsIn(car)).toBe(1);
    expect(freeSeatsIn([...car, { status: "ARRIVED", seats: 2 }])).toBe(0);
    expect(seatStates(car as Parameters<typeof seatStates>[0])).toEqual(["onboard", "onboard", "coming", "empty"]);
  });

  it("what drivers read", () => {
    expect(bookingLabel("SHARED", 1)).toBe("Shared · 1 seat");
    expect(bookingLabel("SHARED", 2)).toBe("Shared · 2 seats");
    expect(bookingLabel("LONE", 1)).toBe("Ride alone");
    expect(bookingLabel("LONE", 3)).toBe("Ride alone · 3 people");
    expect(offerKindLabel("LONE", 3)).toBe("Ride alone · 3 people");
    expect(carSeatsLabel(3)).toBe("3 of 4 seats taken");
    expect(notEnoughSeatsText(2, 1)).toBe("Needs 2 seats, you have 1.");
    expect(notEnoughSeatsText(1, 0)).toBe("Your car is full.");
  });

  it("what the rider reads", () => {
    expect(seatsWithPrice(2, "GH₵14")).toBe("2 seats · GH₵14");
    expect(seatsWithPrice(1, "GH₵7")).toBe("GH₵7");
  });
});
