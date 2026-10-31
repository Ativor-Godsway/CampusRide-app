/** The words pages put on numbers: verdict chips, insights, offer lines, cash status, driver status. */
import { describe, expect, it } from "vitest";
import { busiestLine, changeLine } from "./Overview";
import { verdictChip, whenMost } from "./SupplyDemand";
import { offerLine } from "./LiveMap";
import { CASH_STATUS, oldestWords } from "./CashOwed";
import { driverNow } from "./Drivers";
import { heatRadius } from "../charts/math";
import { rideStatusChip, shortName, initials } from "../lib/labels";
import { rideColumns } from "./rideColumns";

describe("Overview words", () => {
  it("the busiest hour line", () => {
    const req = new Array<number>(24).fill(0);
    const drv = new Array<number>(24).fill(0);
    expect(busiestLine(req, drv)).toBe("No requests yet today.");
    req[18] = 10;
    drv[18] = 4;
    req[9] = 1;
    expect(busiestLine(req, drv)).toBe("Busiest at 6 pm: 10 requests, 4 drivers.");
  });
  it("the change against a week earlier", () => {
    expect(changeLine(23, 18, "last Saturday")).toEqual({ text: "+5 on last Saturday", tone: "good" });
    expect(changeLine(3, 5, "last week")).toEqual({ text: "−2 on last week", tone: "bad" });
    expect(changeLine(4, 4, "last week").text).toBe("Same as last week");
  });
});

describe("Supply & demand words", () => {
  it("verdict chips name the number and the window", () => {
    expect(verdictChip({ need: 0, window: null })).toEqual({ label: "OK", tone: "green" });
    expect(verdictChip({ need: 1, window: "4–7 pm" })).toEqual({ label: "Need 1 more driver 4–7 pm", tone: "amber" });
    expect(verdictChip({ need: 2, window: "4–7 pm" })).toEqual({ label: "Need 2 more drivers 4–7 pm", tone: "red" });
  });
  it("when no-driver requests were most common", () => {
    const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    expect(whenMost(grid)).toBeNull();
    grid[4]![18] = 5;
    grid[5]![19] = 4;
    grid[0]![8] = 1;
    expect(whenMost(grid)).toBe("Most on Fri and Sat evenings");
  });
});

describe("Live map words", () => {
  it("how a waiting request was offered", () => {
    expect(offerLine({ offeredTo: 0, declined: 0, timedOut: 0 })).toBe("No driver near enough to offer it to yet");
    expect(offerLine({ offeredTo: 2, declined: 2, timedOut: 0 })).toBe("Offered to 2 drivers, both declined");
    expect(offerLine({ offeredTo: 3, declined: 1, timedOut: 1 })).toBe("Offered to 3 drivers, 1 declined, 1 didn't answer");
    expect(offerLine({ offeredTo: 1, declined: 0, timedOut: 0 })).toBe("Offered to 1 driver");
  });
});

describe("Cash and drivers", () => {
  it("status chips are words", () => {
    expect(CASH_STATUS.PART_PAID).toEqual({ label: "Part paid", tone: "amber" });
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(oldestWords(null, now)).toBe("nothing unpaid");
    expect(oldestWords("2026-10-23T12:00:00Z", now)).toBe("oldest from last week");
    expect(oldestWords("2026-10-29T12:00:00Z", now)).toBe("oldest from 2 days ago");
  });
  it("what a driver is doing now", () => {
    const base = { isApproved: true, suspended: false, isOnline: false, onTrip: false };
    expect(driverNow(base).label).toBe("Offline");
    expect(driverNow({ ...base, isOnline: true }).label).toBe("Online");
    expect(driverNow({ ...base, isOnline: true, onTrip: true }).label).toBe("On trip");
    expect(driverNow({ ...base, isApproved: false }).label).toBe("Needs approval");
    expect(driverNow({ ...base, suspended: true }).label).toBe("Suspended");
  });
  it("ride status chips always carry a word", () => {
    expect(rideStatusChip({ status: "CANCELLED", cancelReason: "NO_DRIVERS_AVAILABLE" })).toEqual({ label: "No driver", tone: "amber" });
    expect(rideStatusChip({ status: "CANCELLED", cancelReason: "RIDER_CANCELLED" }).label).toBe("Rider cancelled");
    expect(rideStatusChip({ status: "IN_PROGRESS" }).label).toBe("On trip");
    expect(shortName("Ama Owusu Mensah")).toBe("Ama M.");
    expect(initials("Kwame Asante")).toBe("KA");
  });
  it("heat dots grow with the square root of the count", () => {
    expect(heatRadius(0, 10)).toBe(0);
    expect(heatRadius(10, 10)).toBe(24);
    expect(heatRadius(1, 4)).toBe(15);
  });
});

describe("ride table columns", () => {
  it("every column on the Rides page; a detail panel drops the one it's about and the type", () => {
    expect(rideColumns({ withSeats: true }).map((c) => c.key)).toEqual(["time", "rider", "driver", "route", "type", "seats", "fare", "status"]);
    expect(rideColumns().map((c) => c.key)).toEqual(["time", "rider", "driver", "route", "type", "fare", "status"]);
    expect(rideColumns({ compact: "driver" }).map((c) => c.key)).toEqual(["time", "rider", "route", "fare", "status"]);
    expect(rideColumns({ compact: "rider" }).map((c) => c.key)).toEqual(["time", "driver", "route", "fare", "status"]);
  });
});
