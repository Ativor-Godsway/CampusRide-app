import { describe, expect, it } from "vitest";
import { REQUEST_GONE_TOAST, classifyClaimFailure } from "./claimOutcome";

describe("classifyClaimFailure", () => {
  it("taken, cancelled or expired: the request is gone", () => {
    const gone = (reason: unknown) =>
      classifyClaimFailure({ status: 409, code: "RIDE_NOT_AVAILABLE", reason });
    expect(gone("TAKEN")).toEqual({ kind: "gone", reason: "TAKEN" });
    expect(gone("CANCELLED")).toEqual({ kind: "gone", reason: "CANCELLED" });
    expect(gone("EXPIRED")).toEqual({ kind: "gone", reason: "EXPIRED" });
    expect(gone(undefined)).toEqual({ kind: "gone", reason: "EXPIRED" });
  });

  it("no answer, a server error or slow down: a network problem, try again", () => {
    for (const status of [undefined, null, 0, 408, 429, 500, 503]) {
      expect(classifyClaimFailure({ status })).toEqual({ kind: "network" });
    }
  });

  it("any other refusal, in the server's words", () => {
    expect(
      classifyClaimFailure({
        status: 409,
        code: "DRIVER_HAS_ACTIVE_RIDE",
        error: "You already have a trip. Finish it before accepting another request.",
      }),
    ).toEqual({
      kind: "refused",
      message: "You already have a trip. Finish it before accepting another request.",
    });
    expect(classifyClaimFailure({ status: 403 })).toEqual({
      kind: "refused",
      message: "Couldn't accept this request.",
    });
  });

  it("says what happened in the toast", () => {
    expect(REQUEST_GONE_TOAST.TAKEN).toBe("That request was taken");
    expect(REQUEST_GONE_TOAST.EXPIRED).toBe("That request expired");
  });
});
