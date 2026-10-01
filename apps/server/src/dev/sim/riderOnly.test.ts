import { describe, expect, it } from "vitest";
import { assertRiderSideRequest, isRiderSideRequest } from "./riderOnly";

describe("the simulator acts as a rider only", () => {
  it("allows the rider-side requests it needs", () => {
    for (const [m, p] of [["POST", "/rides"], ["POST", "/rides/abc/cancel"], ["POST", "/rides/abc/decision"], ["POST", "/ratings"]]) {
      expect(isRiderSideRequest(m!, p!), `${m} ${p}`).toBe(true);
    }
  });

  it("refuses every driver-side action", () => {
    for (const p of [
      "/rides/abc/claim",
      "/rides/abc/reject",
      "/rides/abc/arrived",
      "/rides/abc/depart",
      "/rides/abc/complete",
      "/rides/abc/add-passenger",
      "/rides/abc/passengers/p1/arrived",
      "/rides/abc/passengers/p1/pickup",
      "/rides/abc/passengers/p1/dropoff",
      "/rides/abc/passengers/p1/cancel",
      "/rides/abc/passengers/p1/no-show",
      "/ratings/rider",
    ]) {
      expect(() => assertRiderSideRequest("POST", p), p).toThrow(/only acts as a rider/);
    }
    expect(() => assertRiderSideRequest("PATCH", "/driver/availability")).toThrow();
  });
});
