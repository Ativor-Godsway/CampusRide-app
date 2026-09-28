import { describe, it, expect } from "vitest";
import {
  RIDER_CANCEL_NOTE_MAX,
  RIDER_CANCEL_REASONS,
  RIDER_CANCEL_REASON_LABELS,
  parseRiderCancelInput,
  riderCancelReasonsFor,
} from "./riderCancel";

describe("parseRiderCancelInput", () => {
  it("accepts no body at all (older app builds)", () => {
    expect(parseRiderCancelInput(undefined, { hasDriver: false })).toEqual({
      ok: true,
      reason: null,
      note: null,
    });
    expect(parseRiderCancelInput({}, { hasDriver: false })).toEqual({
      ok: true,
      reason: null,
      note: null,
    });
  });

  it("accepts a known reason with a trimmed note", () => {
    expect(
      parseRiderCancelInput({ reason: "OTHER", note: "  my class moved  " }, { hasDriver: false }),
    ).toEqual({
      ok: true,
      reason: "OTHER",
      note: "my class moved",
    });
  });

  it("stores a blank note as null", () => {
    expect(parseRiderCancelInput({ reason: "OTHER", note: "   " }, { hasDriver: false })).toEqual({
      ok: true,
      reason: "OTHER",
      note: null,
    });
  });

  it("rejects an unknown reason", () => {
    const result = parseRiderCancelInput({ reason: "BORED" }, { hasDriver: false });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string reason", () => {
    expect(parseRiderCancelInput({ reason: 3 }, { hasDriver: false }).ok).toBe(false);
  });

  it("allows exactly the maximum note length and rejects one more", () => {
    const max = "x".repeat(RIDER_CANCEL_NOTE_MAX);
    expect(parseRiderCancelInput({ reason: "OTHER", note: max }, { hasDriver: false }).ok).toBe(
      true,
    );
    expect(
      parseRiderCancelInput({ reason: "OTHER", note: `${max}x` }, { hasDriver: false }).ok,
    ).toBe(false);
  });

  it("rejects a non-string note, and a note without a reason", () => {
    expect(parseRiderCancelInput({ reason: "OTHER", note: 5 }, { hasDriver: false }).ok).toBe(
      false,
    );
    expect(parseRiderCancelInput({ note: "hi" }, { hasDriver: false }).ok).toBe(false);
  });

  it("only accepts driver-stage reasons once a driver is assigned", () => {
    expect(
      parseRiderCancelInput({ reason: "DRIVER_ASKED_TO_CANCEL" }, { hasDriver: false }).ok,
    ).toBe(false);
    expect(
      parseRiderCancelInput({ reason: "DRIVER_ASKED_TO_CANCEL" }, { hasDriver: true }),
    ).toEqual({
      ok: true,
      reason: "DRIVER_ASKED_TO_CANCEL",
      note: null,
    });
  });
});

describe("riderCancelReasonsFor", () => {
  it("offers driver reasons only after assignment, and always ends with Other", () => {
    const searching = riderCancelReasonsFor("searching");
    const assigned = riderCancelReasonsFor("driver_assigned");
    expect(searching).not.toContain("DRIVER_ASKED_TO_CANCEL");
    expect(assigned).toContain("DRIVER_ASKED_TO_CANCEL");
    expect(assigned).toContain("DRIVER_TOO_SLOW");
    expect(searching[searching.length - 1]).toBe("OTHER");
    expect(assigned[assigned.length - 1]).toBe("OTHER");
  });

  it("has a label for every reason", () => {
    for (const reason of RIDER_CANCEL_REASONS)
      expect(RIDER_CANCEL_REASON_LABELS[reason]).toBeTruthy();
  });
});
