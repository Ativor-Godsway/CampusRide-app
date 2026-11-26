/**
 * What dispatch did for each search, in memory (searchProgress.ts). Pins:
 * drivers add up within one search, a new search (a new broadcastStartedAt)
 * starts again from nothing, once campus-wide always campus-wide, and a
 * re-offer or decline for another search changes nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetSearch,
  noteSearchDeclined,
  noteSearchDispatched,
  noteSearchOfferedTo,
  resetSearchProgressForTests,
  searchProgress,
} from "./searchProgress";

beforeEach(() => resetSearchProgressForTests());

describe("search progress", () => {
  it("adds up within one search; a new search starts from nothing", () => {
    noteSearchDispatched("r1", 1000, { driverIds: ["a", "b"], scope: "nearby", carsChecked: 3 });
    noteSearchDispatched("r1", 1000, { driverIds: ["b", "c"], scope: "campus", carsChecked: 2 });
    noteSearchOfferedTo("r1", 1000, "d");
    noteSearchDeclined("r1", "a");
    const one = searchProgress("r1", 1000)!;
    expect([...one.offered].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...one.declined]).toEqual(["a"]);
    expect(one.scope).toBe("campus");
    expect(one.carsChecked).toBe(3);

    // "Search again": a new broadcastStartedAt.
    expect(searchProgress("r1", 2000)).toBeNull();
    noteSearchOfferedTo("r1", 2000, "x");
    expect(searchProgress("r1", 1000)!.offered.has("x")).toBe(false);
    const two = noteSearchDispatched("r1", 2000, { driverIds: ["e"], scope: "nearby", carsChecked: 1 });
    expect([...two.offered]).toEqual(["e"]);
    expect(two.declined.size).toBe(0);
    expect(searchProgress("r1", 1000)).toBeNull();
  });

  it("forgotten once closed", () => {
    noteSearchDispatched("r2", 1, { driverIds: ["a"], scope: "nearby", carsChecked: 1 });
    forgetSearch("r2");
    expect(searchProgress("r2", 1)).toBeNull();
    // A late decline for a closed search is ignored.
    noteSearchDeclined("r2", "a");
    expect(searchProgress("r2", 1)).toBeNull();
  });
});
