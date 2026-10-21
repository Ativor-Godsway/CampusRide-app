import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { resolveAppMinVersions } from "../lib/appMinVersions";
import { registerAppVersionRoutes } from "./appVersion";

const PLAY = "https://play.google.com/store/apps/details?id=com.campusride.";

async function get(env: Record<string, string | undefined>) {
  const app = Fastify();
  registerAppVersionRoutes(app, resolveAppMinVersions(env).versions);
  await app.ready();
  return app.inject({ method: "GET", url: "/app/min-version" });
}

describe("GET /app/min-version", () => {
  it("blocks nobody when nothing is set, with the Play links and no App Store links", async () => {
    const res = await get({});
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      rider: {
        ios: { minVersion: null, storeUrl: null },
        android: { minVersion: null, storeUrl: `${PLAY}rider` },
      },
      driver: {
        ios: { minVersion: null, storeUrl: null },
        android: { minVersion: null, storeUrl: `${PLAY}driver` },
      },
    });
  });

  it("serves each Render variable in its own place", async () => {
    const res = await get({
      MIN_VERSION_RIDER_IOS: "1.1.0",
      MIN_VERSION_RIDER_ANDROID: " 1.2.0 ",
      MIN_VERSION_DRIVER_IOS: "2.0",
      MIN_VERSION_DRIVER_ANDROID: "2.1.3",
      STORE_URL_RIDER_IOS: "https://apps.apple.com/app/id1",
      STORE_URL_DRIVER_IOS: "https://apps.apple.com/app/id2",
      STORE_URL_DRIVER_ANDROID: "https://play.google.com/store/apps/details?id=other",
    });
    expect(res.json()).toEqual({
      rider: {
        ios: { minVersion: "1.1.0", storeUrl: "https://apps.apple.com/app/id1" },
        android: { minVersion: "1.2.0", storeUrl: `${PLAY}rider` },
      },
      driver: {
        ios: { minVersion: "2.0", storeUrl: "https://apps.apple.com/app/id2" },
        android: { minVersion: "2.1.3", storeUrl: "https://play.google.com/store/apps/details?id=other" },
      },
    });
  });
});

describe("resolveAppMinVersions", () => {
  it("treats a blank value as unset", () => {
    const { versions, invalid } = resolveAppMinVersions({ MIN_VERSION_RIDER_ANDROID: "  ", STORE_URL_RIDER_ANDROID: "" });
    expect(versions.rider.android).toEqual({ minVersion: null, storeUrl: `${PLAY}rider` });
    expect(invalid).toEqual([]);
  });

  it("ignores a value it can't use, and names the variable (never the value)", () => {
    const { versions, invalid } = resolveAppMinVersions({
      MIN_VERSION_RIDER_ANDROID: "1.2.0-beta",
      MIN_VERSION_DRIVER_IOS: "latest",
      STORE_URL_RIDER_ANDROID: "http://play.google.com/x",
    });
    expect(versions.rider.android).toEqual({ minVersion: null, storeUrl: `${PLAY}rider` });
    expect(versions.driver.ios.minVersion).toBeNull();
    expect(invalid).toEqual(["MIN_VERSION_RIDER_ANDROID", "STORE_URL_RIDER_ANDROID", "MIN_VERSION_DRIVER_IOS"]);
  });
});
