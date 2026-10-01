import { describe, expect, it } from "vitest";
import { SLIDE_COMPLETE_AT, enteredEndZone, slideProgress, slideRelease } from "./slideToConfirm";

const TRAVEL = 260; // points the knob can move on an iPhone-width track

describe("slide to confirm", () => {
  it("follows the finger, clamped to the track", () => {
    expect(slideProgress(130, TRAVEL)).toBe(0.5);
    expect(slideProgress(-40, TRAVEL)).toBe(0); // dragging left of the start
    expect(slideProgress(400, TRAVEL)).toBe(1); // past the end
    expect(slideProgress(50, 0)).toBe(0); // before the track is measured
    expect(slideProgress(Number.NaN, TRAVEL)).toBe(0);
  });

  it("snaps back when let go early, and confirms in the end zone", () => {
    expect(slideRelease(slideProgress(0.84 * TRAVEL, TRAVEL))).toBe("snapBack");
    expect(slideRelease(slideProgress(0.3 * TRAVEL, TRAVEL))).toBe("snapBack");
    expect(slideRelease(SLIDE_COMPLETE_AT)).toBe("confirm");
    expect(slideRelease(1)).toBe("confirm");
  });

  it("fires the 'almost there' haptic once, on entering the end zone", () => {
    const path = [0, 0.3, 0.6, 0.84, 0.86, 0.95, 1, 0.9];
    const fired = path.slice(1).filter((p, i) => enteredEndZone(path[i]!, p));
    expect(fired).toEqual([0.86]);
    // Back out and in again: fires again (a new approach to the end).
    expect(enteredEndZone(0.7, 0.9)).toBe(true);
  });
});
