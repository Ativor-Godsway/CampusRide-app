import { describe, expect, it } from "vitest";
import { SIM_SPOTS, planRequests } from "./plan";

describe("the request simulator's plan", () => {
  const plan = planRequests({ count: 12, minutes: 4, sharedRatio: 0.75, seed: 7 });

  it("spreads the requests over the minutes, first at once, last at the end", () => {
    expect(plan).toHaveLength(12);
    expect(plan[0]!.atMs).toBe(0);
    expect(plan[11]!.atMs).toBe(4 * 60_000);
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.atMs).toBeGreaterThan(plan[i - 1]!.atMs);
  });

  it("picks up at every campus spot, never drops off where it picked up", () => {
    expect(new Set(plan.map((p) => p.pickup))).toEqual(new Set(SIM_SPOTS.map((s) => s.key)));
    for (const p of plan) expect(p.dropoff).not.toBe(p.pickup);
  });

  it("is mostly Shared, with some Ride alone, and the same for the same seed", () => {
    const shared = plan.filter((p) => p.type === "SHARED").length;
    expect(shared).toBeGreaterThan(5);
    expect(shared).toBeLessThan(12);
    expect(planRequests({ count: 12, minutes: 4, sharedRatio: 0.75, seed: 7 })).toEqual(plan);
  });

  it("works with only some spots, and refuses fewer than two", () => {
    expect(new Set(planRequests({ count: 4, minutes: 1, sharedRatio: 1, seed: 1, spots: ["bani", "jean-nelson"] }).map((p) => p.pickup))).toEqual(new Set(["bani", "jean-nelson"]));
    expect(() => planRequests({ count: 1, minutes: 1, sharedRatio: 1, seed: 1, spots: ["bani"] })).toThrow();
  });
});
