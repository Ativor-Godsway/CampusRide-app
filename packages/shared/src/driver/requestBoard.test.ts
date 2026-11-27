import { describe, expect, it } from "vitest";
import {
  BOARD_ALL,
  boardDropoffChips,
  boardPickupChips,
  boardTakeSummary,
  filterBoard,
  planBoardTake,
  settleBoardFilter,
  type BoardRequest,
} from "./requestBoard";

const req = (rideId: string, pickup: string, dropoff: string, extra: Partial<BoardRequest> = {}): BoardRequest => ({
  rideId,
  type: "SHARED",
  seats: 1,
  pickupZoneId: pickup,
  pickupZoneName: pickup,
  dropoffZoneId: dropoff,
  dropoffZoneName: dropoff,
  pickupDistanceMeters: null,
  createdAt: "2026-11-25T08:00:00Z",
  ...extra,
});

const board = [
  req("a", "Pentagon", "Balme", { pickupDistanceMeters: 900 }),
  req("b", "Pentagon", "JQB", { pickupDistanceMeters: 300 }),
  req("c", "Pentagon", "Balme", { pickupDistanceMeters: 500 }),
  req("d", "JQB", "Pentagon", { pickupDistanceMeters: 100 }),
  req("e", "Jean Nelson", "TF", { type: "LONE" }),
];

describe("board filters", () => {
  it("pickup chips: All, then each pickup with a count, most first", () => {
    expect(boardPickupChips(board)).toEqual([
      { key: BOARD_ALL, label: "All", count: 5 },
      { key: "Pentagon", label: "Pentagon", count: 3 },
      { key: "Jean Nelson", label: "Jean Nelson", count: 1 },
      { key: "JQB", label: "JQB", count: 1 },
    ]);
  });

  it("drop-off chips are the drop-offs within the pickup filter", () => {
    expect(boardDropoffChips(board, "Pentagon").map((c) => [c.label, c.count])).toEqual([["All", 3], ["Balme", 2], ["JQB", 1]]);
    expect(boardDropoffChips(board, BOARD_ALL)[0]).toEqual({ key: BOARD_ALL, label: "All", count: 5 });
  });

  it("filters by pickup, then drop-off, nearest first, unknown distance last", () => {
    expect(filterBoard(board, { pickup: "Pentagon", dropoff: BOARD_ALL }).map((r) => r.rideId)).toEqual(["b", "c", "a"]);
    expect(filterBoard(board, { pickup: "Pentagon", dropoff: "Balme" }).map((r) => r.rideId)).toEqual(["c", "a"]);
    expect(filterBoard(board, { pickup: BOARD_ALL, dropoff: BOARD_ALL }).map((r) => r.rideId)).toEqual(["d", "b", "c", "a", "e"]);
  });

  it("a filter whose requests are all gone falls back to All", () => {
    expect(settleBoardFilter(board, { pickup: "Bani", dropoff: "Balme" })).toEqual({ pickup: BOARD_ALL, dropoff: BOARD_ALL });
    expect(settleBoardFilter(board, { pickup: "Pentagon", dropoff: "TF" })).toEqual({ pickup: "Pentagon", dropoff: BOARD_ALL });
    expect(settleBoardFilter(board, { pickup: "Pentagon", dropoff: "Balme" })).toEqual({ pickup: "Pentagon", dropoff: "Balme" });
  });
});

describe("Add to my trip: what a selection may hold", () => {
  const shared = (id: string, seats = 1, d: number | null = null) => req(id, "Pentagon", "Balme", { seats, pickupDistanceMeters: d });

  it("no trip: the nearest Shared request is claimed, the rest added", () => {
    expect(planBoardTake([shared("far", 1, 800), shared("near", 1, 100), shared("mid", 1, 400)], null)).toEqual({
      ok: true,
      claim: "near",
      add: ["mid", "far"],
      seats: 3,
    });
  });

  it("no trip: at most 4 seats (a booking for 2 takes 2)", () => {
    expect(planBoardTake([shared("a", 2), shared("b", 2)], null)).toMatchObject({ ok: true, seats: 4 });
    expect(planBoardTake([shared("a", 2), shared("b", 2), shared("c")], null)).toEqual({ ok: false, message: "Needs 5 seats: a car has 4." });
  });

  it("Ride alone is taken on its own, never with others", () => {
    const lone = req("lone", "JQB", "TF", { type: "LONE" });
    expect(planBoardTake([lone], null)).toEqual({ ok: true, claim: "lone", add: [], seats: 1 });
    expect(planBoardTake([lone, shared("a")], null)).toMatchObject({ ok: false });
  });

  it("on a Shared trip: Shared only, within the free seats; a full car takes nobody", () => {
    const car = { rideId: "car", type: "SHARED" as const, freeSeats: 2 };
    expect(planBoardTake([shared("a"), shared("b")], car)).toEqual({ ok: true, claim: null, add: ["a", "b"], seats: 2 });
    expect(planBoardTake([shared("a"), shared("b"), shared("c")], car)).toEqual({ ok: false, message: "Needs 3 seats, you have 2." });
    // Seats, not bookings: one 2-seat booking doesn't fit a car with 1 free seat.
    expect(planBoardTake([shared("a", 2)], { ...car, freeSeats: 1 })).toEqual({ ok: false, message: "Needs 2 seats, you have 1." });
    expect(planBoardTake([shared("a", 2), shared("b", 1)], { ...car, freeSeats: 3 })).toMatchObject({ ok: true, seats: 3 });
    expect(planBoardTake([shared("a")], { ...car, freeSeats: 0 })).toEqual({ ok: false, message: "Your car is full." });
    expect(planBoardTake([req("l", "JQB", "TF", { type: "LONE" })], car)).toMatchObject({ ok: false });
  });

  it("on a Ride alone trip: nothing", () => {
    expect(planBoardTake([shared("a")], { rideId: "car", type: "LONE", freeSeats: 0 })).toMatchObject({ ok: false });
  });

  it("nothing selected", () => {
    expect(planBoardTake([], null)).toMatchObject({ ok: false });
  });

  it("says what happened, already taken included", () => {
    expect(boardTakeSummary([{ rideId: "a", outcome: "added" }, { rideId: "b", outcome: "added" }, { rideId: "c", outcome: "taken" }])).toBe(
      "2 added. 1 was already taken.",
    );
    expect(boardTakeSummary([{ rideId: "a", outcome: "refused", message: "Your car is full." }])).toBe("Your car is full.");
  });
});
