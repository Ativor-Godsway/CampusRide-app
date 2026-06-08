import { describe, it, expect } from "vitest";
import { isDefiniteFailure, isDefiniteSuccess, TX_STATUS } from "./constants";

describe("txstatus rule — only 2 is a definite failure", () => {
  it("treats SUCCESS (1) as success, not failure", () => {
    expect(isDefiniteSuccess(TX_STATUS.SUCCESS)).toBe(true);
    expect(isDefiniteFailure(TX_STATUS.SUCCESS)).toBe(false);
  });

  it("treats PENDING (0) as neither success nor failure", () => {
    expect(isDefiniteSuccess(TX_STATUS.PENDING)).toBe(false);
    expect(isDefiniteFailure(TX_STATUS.PENDING)).toBe(false);
  });

  it("treats FAILED (2) as a definite failure", () => {
    expect(isDefiniteFailure(TX_STATUS.FAILED)).toBe(true);
    expect(isDefiniteSuccess(TX_STATUS.FAILED)).toBe(false);
  });

  it("treats UNKNOWN (3) as neither success nor failure", () => {
    expect(isDefiniteSuccess(TX_STATUS.UNKNOWN)).toBe(false);
    expect(isDefiniteFailure(TX_STATUS.UNKNOWN)).toBe(false);
  });
});
