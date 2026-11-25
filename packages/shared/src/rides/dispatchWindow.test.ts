import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_WINDOW_SECONDS, DISPATCH_WINDOW_MS, dispatchSecondsLeft, searchElapsedSeconds, searchWindowProblem, stopwatch } from "./dispatchWindow";

describe("the search window", () => {
  const start = "2026-11-25T08:00:00.000Z";
  const at = (s: number) => Date.parse(start) + s * 1000;

  it("is 7 minutes by default", () => {
    expect(DEFAULT_SEARCH_WINDOW_SECONDS).toBe(420);
    expect(DISPATCH_WINDOW_MS).toBe(420_000);
  });

  it("counts down from the window, never below 0; null without a start", () => {
    expect(dispatchSecondsLeft(start, at(0))).toBe(420);
    expect(dispatchSecondsLeft(start, at(419.5))).toBe(1);
    expect(dispatchSecondsLeft(start, at(500))).toBe(0);
    expect(dispatchSecondsLeft(start, at(60), 120_000)).toBe(60);
    expect(dispatchSecondsLeft(null, at(0))).toBeNull();
    expect(dispatchSecondsLeft("not a date", at(0))).toBeNull();
  });

  it("the searching screen's stopwatch", () => {
    expect(searchElapsedSeconds(start, at(125.7))).toBe(125);
    expect(searchElapsedSeconds(start, at(-5))).toBe(0);
    expect(searchElapsedSeconds(undefined, at(0))).toBeNull();
    expect(stopwatch(0)).toBe("0:00");
    expect(stopwatch(125)).toBe("2:05");
    expect(stopwatch(420)).toBe("7:00");
  });

  it("an admin may set 1 to 30 minutes", () => {
    expect(searchWindowProblem(420)).toBeNull();
    expect(searchWindowProblem(60)).toBeNull();
    expect(searchWindowProblem(59)).not.toBeNull();
    expect(searchWindowProblem(1801)).not.toBeNull();
    expect(searchWindowProblem(90.5)).not.toBeNull();
  });
});
