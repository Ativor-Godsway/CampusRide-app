import { describe, expect, it } from "vitest";
import {
  FINISHING_TRIPS_AFTER_MS,
  SEARCH_STEP_DONE_MS,
  cancelSearchLine,
  distanceWords,
  freeWaitWords,
  parseRideSearchStatus,
  roundToHundredMeters,
  searchLiveNote,
  searchSteps,
  searchTips,
  usualWaitRange,
  type RideSearchStatus,
} from "./searchStatus";

const S = 1000;

function status(over: Partial<RideSearchStatus> = {}): RideSearchStatus {
  return {
    rideId: "r1",
    searchStartedAt: "2026-11-26T10:00:00.000Z",
    driversOffered: 3,
    driversWithIt: 3,
    scope: "nearby",
    carsChecked: 5,
    nearestFreeCarMeters: 300,
    driversOnTrips: null,
    firstInLine: true,
    usualWait: { fromMinutes: 1, toMinutes: 3 },
    freeWaitSeconds: 150,
    cars: [],
    ...over,
  };
}

const states = (ms: number, s: RideSearchStatus | null = status()) => searchSteps(ms, s, "Akuafo Hall").map((x) => x.state);
const labels = (ms: number, s: RideSearchStatus | null = status(), where: string | null = "Akuafo Hall") =>
  searchSteps(ms, s, where).map((x) => x.label);

describe("searchSteps: order and timings", () => {
  it("always the same four steps, in order", () => {
    expect(searchSteps(0, null, null).map((s) => s.key)).toEqual(["send", "offer", "check", "accept"]);
  });

  it("0–5 s sending, 5–20 s finding drivers, 20–45 s checking cars, then waiting for an accept", () => {
    expect(states(0)).toEqual(["active", "pending", "pending", "pending"]);
    expect(states(4_999)).toEqual(["active", "pending", "pending", "pending"]);
    expect(states(5 * S)).toEqual(["done", "active", "pending", "pending"]);
    expect(states(19_999)).toEqual(["done", "active", "pending", "pending"]);
    expect(states(20 * S)).toEqual(["done", "done", "active", "pending"]);
    expect(states(44_999)).toEqual(["done", "done", "active", "pending"]);
    expect(states(45 * S)).toEqual(["done", "done", "done", "active"]);
    // The wait never "finishes" by itself: only an accept (which ends the screen) does.
    expect(states(7 * 60 * S)).toEqual(["done", "done", "done", "active"]);
    expect(SEARCH_STEP_DONE_MS).toEqual({ send: 5_000, offer: 20_000, check: 45_000 });
  });

  it("a clock a little ahead of the server reads as the start", () => {
    expect(states(-3_000)).toEqual(["active", "pending", "pending", "pending"]);
  });

  it("the wording of each step, active then done", () => {
    expect(labels(0)).toEqual([
      "Sending your request…",
      "Finding drivers near Akuafo Hall…",
      "Checking cars with free seats going your way…",
      "Waiting for a driver to accept",
    ]);
    expect(labels(45 * S)).toEqual(["Request sent", "Shown to 3 drivers nearby", "5 cars checked", "Waiting for a driver to accept"]);
  });

  it("each row lists every wording it can take (so it keeps one height)", () => {
    const [send, offer, check, accept] = searchSteps(0, status(), "Akuafo Hall");
    expect(send!.labels).toEqual(["Sending your request…", "Request sent"]);
    expect(offer!.labels).toEqual(["Finding drivers near Akuafo Hall…", "Shown to 3 drivers nearby"]);
    expect(check!.labels).toEqual(["Checking cars with free seats going your way…", "5 cars checked"]);
    expect(accept!.labels).toEqual(["Waiting for a driver to accept"]);
  });
});

describe("searchSteps: real numbers only", () => {
  it("one driver, one car: singular", () => {
    expect(labels(45 * S, status({ driversOffered: 1, carsChecked: 1 })).slice(1, 3)).toEqual(["Shown to 1 driver nearby", "1 car checked"]);
  });

  it("campus-wide: 'on campus'", () => {
    expect(labels(45 * S, status({ scope: "campus", driversOffered: 6 }))[1]).toBe("Shown to 6 drivers on campus");
  });

  it("nobody to show it to: says so, never 'Shown to 0'", () => {
    const l = labels(45 * S, status({ driversOffered: 0, carsChecked: 0 }));
    expect(l[1]).toBe("No driver free nearby yet");
    expect(l[2]).toBe("No free cars yet");
    expect(labels(45 * S, status({ driversOffered: 0, scope: "campus" }))[1]).toBe("No driver free on campus yet");
  });

  it("no status (yet, or an old server): wording without a number", () => {
    const l = labels(45 * S, null);
    expect(l).toEqual(["Request sent", "Searched for drivers near Akuafo Hall", "Cars checked", "Waiting for a driver to accept"]);
    for (const text of l) expect(text).not.toMatch(/\d/);
    const unknown = status({ driversOffered: null, carsChecked: null, usualWait: null });
    expect(labels(45 * S, unknown).join(" ")).not.toMatch(/\d/);
    expect(searchSteps(45 * S, unknown, "Akuafo Hall")[3]!.detail).toBeNull();
  });

  it("no place name: 'near you'", () => {
    expect(labels(6 * S, null, null)[1]).toBe("Finding drivers near you…");
    expect(labels(6 * S, null, "   ")[1]).toBe("Finding drivers near you…");
  });

  it("'Usually 1–3 min' under the waiting step, from the server's range", () => {
    expect(searchSteps(50 * S, status(), null)[3]!.detail).toBe("Usually 1–3 min");
    expect(searchSteps(50 * S, status({ usualWait: { fromMinutes: 2, toMinutes: 4 } }), null)[3]!.detail).toBe("Usually 2–4 min");
    // Given before the step is reached too (the screen keeps room for it and hides it).
    expect(searchSteps(0, status(), null)[3]).toMatchObject({ state: "pending", detail: "Usually 1–3 min" });
  });
});

describe("usualWaitRange", () => {
  it("median to 75th percentile in whole minutes, at least 1–2 min, top above bottom", () => {
    expect(usualWaitRange(114, 180)).toEqual({ fromMinutes: 2, toMinutes: 3 });
    expect(usualWaitRange(20, 40)).toEqual({ fromMinutes: 1, toMinutes: 2 });
    expect(usualWaitRange(60, 70)).toEqual({ fromMinutes: 1, toMinutes: 2 });
    expect(usualWaitRange(150, 155)).toEqual({ fromMinutes: 3, toMinutes: 4 });
    expect(usualWaitRange(90, 400)).toEqual({ fromMinutes: 2, toMinutes: 7 });
    expect(usualWaitRange(Number.NaN, 100)).toBeNull();
  });
});

describe("searchLiveNote", () => {
  it("the nearest free-seat car once the request is out", () => {
    expect(searchLiveNote(2 * S, status())).toBeNull();
    expect(searchLiveNote(6 * S, status())).toBe("A car with a free seat is 300 m away");
    expect(searchLiveNote(6 * S, status({ nearestFreeCarMeters: 1200 }))).toBe("A car with a free seat is 1.2 km away");
    expect(searchLiveNote(6 * S, status({ nearestFreeCarMeters: null }))).toBeNull();
    expect(searchLiveNote(60 * S, null)).toBeNull();
  });

  it("from 2:30, only while drivers are busy on trips; first in line only when true", () => {
    const busy = status({ driversOnTrips: "nearby", nearestFreeCarMeters: null });
    expect(searchLiveNote(FINISHING_TRIPS_AFTER_MS - 1, busy)).toBeNull();
    expect(searchLiveNote(FINISHING_TRIPS_AFTER_MS, busy)).toBe("Drivers are finishing nearby trips. You're still first in line.");
    expect(searchLiveNote(FINISHING_TRIPS_AFTER_MS, { ...busy, firstInLine: false })).toBe("Drivers are finishing nearby trips.");
    expect(searchLiveNote(FINISHING_TRIPS_AFTER_MS, { ...busy, driversOnTrips: "campus" })).toBe(
      "Drivers are finishing trips on campus. You're still first in line.",
    );
    // Nobody busy: the line about trips never shows.
    expect(searchLiveNote(5 * 60 * S, status({ driversOnTrips: null }))).toBe("A car with a free seat is 300 m away");
  });
});

describe("tips, cancel line, words", () => {
  it("the four tips in order, the free wait as set now", () => {
    expect(searchTips(status())).toEqual([
      "We'll notify you as soon as a driver accepts",
      "Be at the pickup: drivers wait 2½ min free",
      "Shared rides from GH₵7",
      "Tip: shared rides fill up fastest near busy halls",
    ]);
    expect(searchTips(status({ freeWaitSeconds: 180 }))[1]).toBe("Be at the pickup: drivers wait 3 min free");
    // Free wait not known: that tip is left out rather than guessed.
    expect(searchTips(null)).toHaveLength(3);
  });

  it("cancel: '3 drivers have it.' only with a real count", () => {
    expect(cancelSearchLine(status())).toBe("3 drivers have it.");
    expect(cancelSearchLine(status({ driversWithIt: 1 }))).toBe("1 driver has it.");
    expect(cancelSearchLine(status({ driversWithIt: 0 }))).toBeNull();
    expect(cancelSearchLine(status({ driversWithIt: null }))).toBeNull();
    expect(cancelSearchLine(null)).toBeNull();
  });

  it("distances and waits as the screen says them", () => {
    expect(roundToHundredMeters(240)).toBe(200);
    expect(roundToHundredMeters(250)).toBe(300);
    expect(roundToHundredMeters(12)).toBe(100);
    expect(distanceWords(800)).toBe("800 m");
    expect(distanceWords(1000)).toBe("1 km");
    expect(distanceWords(2340)).toBe("2.3 km");
    expect(freeWaitWords(150)).toBe("2½ min");
    expect(freeWaitWords(120)).toBe("2 min");
    expect(freeWaitWords(100)).toBe("1 min 40 s");
    expect(freeWaitWords(30)).toBe("30 s");
  });
});

describe("parseRideSearchStatus", () => {
  it("reads a full status", () => {
    const s = status({ cars: [{ key: "k", latitude: 5.65, longitude: -0.18, heading: 90 }] });
    expect(parseRideSearchStatus(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("anything that doesn't check out reads as not known", () => {
    expect(parseRideSearchStatus(null)).toBeNull();
    expect(parseRideSearchStatus({})).toBeNull();
    const odd = parseRideSearchStatus({
      rideId: "r1",
      searchStartedAt: "nope",
      driversOffered: -1,
      driversWithIt: 2.5,
      scope: "everywhere",
      carsChecked: "5",
      nearestFreeCarMeters: 0,
      driversOnTrips: 1,
      firstInLine: "yes",
      usualWait: { fromMinutes: 3, toMinutes: 3 },
      freeWaitSeconds: 0,
      cars: [{ key: "k", latitude: "x", longitude: 1, heading: null }, { key: "ok", latitude: 1, longitude: 2, heading: null }],
    });
    expect(odd).toEqual({
      rideId: "r1",
      searchStartedAt: null,
      driversOffered: null,
      driversWithIt: null,
      scope: null,
      carsChecked: null,
      nearestFreeCarMeters: null,
      driversOnTrips: null,
      firstInLine: false,
      usualWait: null,
      freeWaitSeconds: null,
      cars: [{ key: "ok", latitude: 1, longitude: 2, heading: null }],
    });
  });
});
