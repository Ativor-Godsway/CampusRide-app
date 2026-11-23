import { describe, expect, it } from "vitest";
import { DRIVER_CANCEL_NOTE_MAX, DRIVER_CANCEL_REASONS, DRIVER_CANCEL_REASON_LABELS, parseDriverCancelInput } from "./driverCancel";

describe("parseDriverCancelInput", () => {
  it("accepts no body at all (driver app builds from before the reasons)", () => {
    expect(parseDriverCancelInput(undefined)).toEqual({ ok: true, reason: null, note: null });
    expect(parseDriverCancelInput({})).toEqual({ ok: true, reason: null, note: null });
  });

  it("accepts every reason, with a trimmed note", () => {
    for (const reason of DRIVER_CANCEL_REASONS) {
      expect(parseDriverCancelInput({ reason })).toEqual({ ok: true, reason, note: null });
    }
    expect(parseDriverCancelInput({ reason: "OTHER", note: "  Flat tyre  " })).toEqual({ ok: true, reason: "OTHER", note: "Flat tyre" });
    expect(parseDriverCancelInput({ reason: "OTHER", note: "   " })).toEqual({ ok: true, reason: "OTHER", note: null });
  });

  it("refuses an unknown reason, a note without a reason, and a long note", () => {
    expect(parseDriverCancelInput({ reason: "NO_SHOW" }).ok).toBe(false);
    expect(parseDriverCancelInput({ note: "hi" }).ok).toBe(false);
    expect(parseDriverCancelInput({ reason: "OTHER", note: 5 }).ok).toBe(false);
    expect(parseDriverCancelInput({ reason: "OTHER", note: "x".repeat(DRIVER_CANCEL_NOTE_MAX + 1) }).ok).toBe(false);
  });

  it("labels every reason", () => {
    for (const reason of DRIVER_CANCEL_REASONS) expect(DRIVER_CANCEL_REASON_LABELS[reason]).toBeTruthy();
  });
});
