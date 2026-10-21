import { describe, expect, it } from "vitest";
import {
  MIN_OFFER_SHOW_MS,
  isOfferLive,
  minutesAndDistance,
  nextOffer,
  offerDeadline,
  offerKindLabel,
  offerStopLines,
  orderOffers,
} from "./rideOffers";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const offer = (rideId: string, meters: number | null, createdAgoMs: number, expiresInMs = 60_000) => ({
  rideId,
  pickupDistanceMeters: meters,
  createdAt: at(-createdAgoMs),
  expiresAt: at(expiresInMs),
});

describe("the offer queue", () => {
  it("nearest pickup first; unknown distances last; then whoever waited longest", () => {
    const ordered = orderOffers([offer("far", 900, 5_000), offer("near", 200, 1_000), offer("unknown", null, 30_000), offer("near-older", 200, 9_000)]);
    expect(ordered.map((o) => o.rideId)).toEqual(["near-older", "near", "far", "unknown"]);
  });

  it("shows one offer at a time: the first not yet handled and not about to expire", () => {
    const list = [offer("a", 100, 0), offer("b", 300, 0), offer("c", 500, 0, MIN_OFFER_SHOW_MS - 1)];
    expect(nextOffer(list, new Set(), NOW)?.rideId).toBe("a");
    expect(nextOffer(list, new Set(["a"]), NOW)?.rideId).toBe("b");
    // "c" has under 4 s left: never popped up.
    expect(nextOffer(list, new Set(["a", "b"]), NOW)).toBeNull();
    expect(nextOffer([], new Set(), NOW)).toBeNull();
  });

  it("a declined or timed-out offer never comes back, even if the server still lists it", () => {
    const list = [offer("a", 100, 0)];
    const handled = new Set(["a"]);
    expect(nextOffer(list, handled, NOW)).toBeNull();
  });

  it("counts down from when it was shown, but never past the request's own end", () => {
    expect(offerDeadline(NOW, 15, at(60_000))).toBe(NOW + 15_000);
    expect(offerDeadline(NOW, 15, at(9_000))).toBe(NOW + 9_000);
    expect(offerDeadline(NOW, 0, "not a date")).toBe(NOW + 1_000);
  });

  it("removes the offer on screen live: taken/cancelled/expired (gone from the list or withdrawn), or timed out", () => {
    const current = { rideId: "a", deadline: NOW + 10_000 };
    expect(isOfferLive(current, [{ rideId: "a" }], new Set(), NOW)).toBe("live");
    expect(isOfferLive(current, [{ rideId: "b" }], new Set(), NOW)).toBe("gone");
    expect(isOfferLive(current, [{ rideId: "a" }], new Set(["a"]), NOW)).toBe("gone");
    expect(isOfferLive(current, [{ rideId: "a" }], new Set(), NOW + 10_000)).toBe("timedOut");
  });
});

describe("offer wording", () => {
  it("names the kind of ride and the seats", () => {
    expect(offerKindLabel("LONE", 1)).toBe("Ride alone");
    expect(offerKindLabel("SHARED", 1)).toBe("Shared · 1 seat");
    expect(offerKindLabel("SHARED", 2)).toBe("Shared · 2 seats");
  });

  it("says minutes and distance plainly", () => {
    expect(minutesAndDistance(4, 1240)).toBe("4 min · 1.2 km");
    expect(minutesAndDistance(0.4, 120)).toBe("under 1 min · 100 m");
    expect(minutesAndDistance(null, 300)).toBe("300 m");
    expect(minutesAndDistance(null, null)).toBe("");
  });
});

describe("offerStopLines", () => {
  it("says how far the pickup is and how long the trip is", () => {
    expect(
      offerStopLines({
        pickupMinutes: 1,
        pickupDistanceMeters: 400,
        tripMinutes: 5,
        tripDistanceMeters: 1600,
      }),
    ).toEqual({ pickup: "Pickup · 1 min · 400 m away", dropoff: "Drop-off · 5 min trip · 1.6 km" });
  });

  it("leaves out what the server didn't send", () => {
    expect(offerStopLines({ pickupMinutes: 0.4, tripDistanceMeters: null })).toEqual({
      pickup: "Pickup · under 1 min",
      dropoff: "Drop-off",
    });
  });
});
