import { describe, expect, it } from "vitest";
import {
  ANDROID_CHANNELS,
  DRIVER_PUSH_KINDS,
  RIDER_PUSH_KINDS,
  appForKind,
  parsePushData,
  pushTapTarget,
  pushText,
} from "./notifications";

const ALL_KINDS = [...RIDER_PUSH_KINDS, ...DRIVER_PUSH_KINDS];

describe("pushText", () => {
  it("uses only the first name", () => {
    expect(pushText("DRIVER_ASSIGNED", { driverName: "Kofi Mensah Boateng" }).body).toBe(
      "Kofi is coming to pick you up.",
    );
    expect(pushText("RIDER_CANCELLED", { riderName: "  Ama  Serwaa " }).body).toBe(
      "Ama cancelled the ride.",
    );
  });

  it("never contains a surname, for every kind", () => {
    for (const kind of ALL_KINDS) {
      const { title, body } = pushText(kind, {
        driverName: "Kofi Mensah",
        riderName: "Ama Serwaa",
        pickupName: "Balme Library",
      });
      expect(`${title} ${body}`, kind).not.toMatch(/Mensah|Serwaa/);
      expect(title.length, kind).toBeGreaterThan(0);
      expect(body.length, kind).toBeGreaterThan(0);
    }
  });

  it("falls back to a neutral word when the name is missing", () => {
    expect(pushText("DRIVER_ARRIVED", {}).body).toBe("Your driver is at your pickup.");
    expect(pushText("RIDER_CANCELLED", { riderName: null }).body).toBe(
      "The rider cancelled the ride.",
    );
  });

  it("says why a pickup was cancelled", () => {
    expect(pushText("DRIVER_CANCELLED", { driverName: "Kofi", noShow: true }).body).toContain(
      "couldn't find you",
    );
    expect(pushText("DRIVER_CANCELLED", { driverName: "Kofi" }).body).toContain(
      "request another ride",
    );
  });

  it("names the pickup on a ride request when known", () => {
    expect(pushText("RIDE_REQUEST", { pickupName: "Night Market" }).body).toBe(
      "Pickup at Night Market. Open the app to accept.",
    );
    expect(pushText("RIDE_REQUEST").body).toBe("Open the app to accept.");
  });
});

describe("appForKind", () => {
  it("sends driver kinds to the driver app and the rest to the rider app", () => {
    expect(appForKind("RIDE_REQUEST")).toBe("driver");
    expect(appForKind("RIDER_CANCELLED")).toBe("driver");
    for (const kind of RIDER_PUSH_KINDS) expect(appForKind(kind)).toBe("rider");
  });
});

describe("ANDROID_CHANNELS", () => {
  it("has the agreed names", () => {
    expect(ANDROID_CHANNELS.driver.name).toBe("Ride requests");
    expect(ANDROID_CHANNELS.rider.name).toBe("Ride updates");
    expect(ANDROID_CHANNELS.driver.id).not.toBe(ANDROID_CHANNELS.rider.id);
  });
});

describe("parsePushData", () => {
  it("accepts our payload", () => {
    expect(parsePushData({ kind: "DRIVER_ARRIVED", rideId: "ckx123abc" })).toEqual({
      kind: "DRIVER_ARRIVED",
      rideId: "ckx123abc",
    });
  });

  it("rejects anything else", () => {
    for (const data of [
      null,
      "x",
      {},
      { kind: "SOMETHING", rideId: "a" },
      { kind: "DRIVER_ARRIVED" },
      { kind: "DRIVER_ARRIVED", rideId: "../../etc" },
      { kind: "DRIVER_ARRIVED", rideId: 42 },
    ]) {
      expect(parsePushData(data), JSON.stringify(data)).toBeNull();
    }
  });
});

describe("pushTapTarget", () => {
  it("opens the trip for live updates, history once it's over, and home for requests", () => {
    expect(pushTapTarget("DRIVER_ARRIVED")).toBe("trip");
    expect(pushTapTarget("NO_DRIVER_FOUND")).toBe("trip");
    expect(pushTapTarget("RIDER_CANCELLED")).toBe("trip");
    expect(pushTapTarget("WENT_OFFLINE")).toBe("home");
    expect(pushTapTarget("TRIP_COMPLETED")).toBe("rides");
    expect(pushTapTarget("RIDE_REQUEST")).toBe("home");
    expect(pushTapTarget("DRIVER_CANCELLED")).toBe("home");
  });
});

describe("the driver taken offline for silence", () => {
  it("goes to the driver app, in the owner's words, and opens Home", () => {
    expect(appForKind("WENT_OFFLINE")).toBe("driver");
    expect(pushText("WENT_OFFLINE")).toEqual({
      title: "You're offline",
      body: "We lost touch with your phone for a while. Go online again when you're ready.",
    });
  });
});
