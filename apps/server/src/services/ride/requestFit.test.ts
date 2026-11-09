import { describe, expect, it } from "vitest";
import { CAR_CAPACITY, carSeats, seatFit } from "./requestFit";

const seats = (...statuses: string[]) => statuses.map((status) => ({ status }));
const sharedCar = (...statuses: string[]) => ({ type: "SHARED", status: "IN_PROGRESS", passengers: seats(...statuses) });

describe("free seats = capacity − on board − waiting for pickup", () => {
  it("counts riders on board and riders waiting; dropped-off and cancelled seats are free", () => {
    expect(carSeats(seats("PICKED_UP", "WAITING", "ARRIVED", "DROPPED_OFF", "CANCELLED"))).toEqual({
      capacity: CAR_CAPACITY,
      onBoard: 1,
      waiting: 2,
      free: 1,
    });
    expect(carSeats(seats("PICKED_UP", "PICKED_UP", "PICKED_UP", "PICKED_UP")).free).toBe(0);
    expect(carSeats([]).free).toBe(4);
  });
});

describe("seatFit", () => {
  const shared = { type: "SHARED", occupancy: 1 };
  const lone = { type: "LONE", occupancy: 1 };

  it("no trip: anything fits", () => {
    expect(seatFit(shared, null)).toBeNull();
    expect(seatFit(lone, null)).toBeNull();
    expect(seatFit({ type: "SHARED", occupancy: 5 }, null)).toBe("NOT_ENOUGH_SEATS");
  });

  it("a Shared car: Shared requests that fit its free seats", () => {
    expect(seatFit(shared, sharedCar("PICKED_UP", "PICKED_UP", "DROPPED_OFF"))).toBeNull();
    expect(seatFit(shared, sharedCar("PICKED_UP", "PICKED_UP", "WAITING", "ARRIVED"))).toBe("CAR_FULL");
    expect(seatFit({ type: "SHARED", occupancy: 2 }, sharedCar("PICKED_UP", "PICKED_UP", "WAITING"))).toBe("NOT_ENOUGH_SEATS");
    expect(seatFit({ type: "SHARED", occupancy: 2 }, sharedCar("PICKED_UP", "WAITING"))).toBeNull();
  });

  it("a Ride alone request needs an empty car; a Ride alone car takes no one", () => {
    expect(seatFit(lone, sharedCar("PICKED_UP"))).toBe("NEEDS_EMPTY_CAR");
    expect(seatFit(shared, { type: "LONE", status: "MATCHED", passengers: seats("WAITING") })).toBe("LONE_CAR");
  });

  it("a car past taking riders takes no one", () => {
    expect(seatFit(shared, { type: "SHARED", status: "COMPLETED", passengers: [] })).toBe("CAR_CLOSED");
  });
});
