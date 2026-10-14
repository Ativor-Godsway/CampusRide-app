import { describe, expect, it } from "vitest";
import { PushRateLimiter } from "./rateLimit";

describe("PushRateLimiter", () => {
  it("drops a repeat of the same notification inside its dedupe window", () => {
    const limiter = new PushRateLimiter({ perUserMax: 10, perUserWindowMs: 60_000 });
    expect(limiter.allow("u1", "DRIVER_ARRIVED:r1", 60_000, 0)).toBe(true);
    expect(limiter.allow("u1", "DRIVER_ARRIVED:r1", 60_000, 30_000)).toBe(false);
    expect(limiter.allow("u1", "DRIVER_ARRIVED:r1", 60_000, 60_001)).toBe(true);
  });

  it("keeps people and rides apart", () => {
    const limiter = new PushRateLimiter({ perUserMax: 10, perUserWindowMs: 60_000 });
    expect(limiter.allow("u1", "DRIVER_ARRIVED:r1", 60_000, 0)).toBe(true);
    expect(limiter.allow("u2", "DRIVER_ARRIVED:r1", 60_000, 0)).toBe(true);
    expect(limiter.allow("u1", "DRIVER_ARRIVED:r2", 60_000, 0)).toBe(true);
    expect(limiter.allow("u1", "TRIP_STARTED:r1", 60_000, 0)).toBe(true);
  });

  it("caps how many one person gets per window", () => {
    const limiter = new PushRateLimiter({ perUserMax: 3, perUserWindowMs: 60_000 });
    expect(limiter.allow("u1", "a", 1, 0)).toBe(true);
    expect(limiter.allow("u1", "b", 1, 1)).toBe(true);
    expect(limiter.allow("u1", "c", 1, 2)).toBe(true);
    expect(limiter.allow("u1", "d", 1, 3)).toBe(false);
    // Someone else is unaffected.
    expect(limiter.allow("u2", "d", 1, 3)).toBe(true);
    // Once the window has moved on, the person can be notified again.
    expect(limiter.allow("u1", "d", 1, 60_001)).toBe(true);
  });

  it("does not count a refused notification as sent", () => {
    const limiter = new PushRateLimiter({ perUserMax: 1, perUserWindowMs: 60_000 });
    expect(limiter.allow("u1", "a", 120_000, 0)).toBe(true);
    expect(limiter.allow("u1", "b", 120_000, 1)).toBe(false);
    // "b" was refused, so it is not deduped: it can go once the cap allows.
    expect(limiter.allow("u1", "b", 120_000, 60_001)).toBe(true);
  });

  it("forgets expired entries on sweep", () => {
    const limiter = new PushRateLimiter({ perUserMax: 10, perUserWindowMs: 60_000 });
    limiter.allow("u1", "a", 1_000, 0);
    limiter.allow("u2", "b", 1_000, 0);
    expect(limiter.size).toBeGreaterThan(0);
    limiter.sweep(120_000);
    expect(limiter.size).toBe(0);
  });
});
