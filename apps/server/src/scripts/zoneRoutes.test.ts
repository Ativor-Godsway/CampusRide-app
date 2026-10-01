import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma";
import { parseOrs, parseOsrm, precomputeZoneRoutes, RoutingHttpError } from "./zoneRoutes";

afterEach(async () => {
  await prisma.zoneRoute.deleteMany({ where: { provider: "test" } });
});

describe("provider responses", () => {
  it("reads OSRM", () => {
    expect(parseOsrm({ code: "Ok", routes: [{ geometry: "abc", distance: 812.4, duration: 95.6 }] })).toEqual({
      polyline: "abc",
      distanceMeters: 812,
      durationSeconds: 96,
    });
    expect(parseOsrm({ code: "NoRoute", routes: [] })).toBeNull();
  });

  it("reads openrouteservice", () => {
    expect(parseOrs({ routes: [{ geometry: "xyz", summary: { distance: 1500, duration: 240 } }] })).toEqual({
      polyline: "xyz",
      distanceMeters: 1500,
      durationSeconds: 240,
    });
    expect(parseOrs({ error: "nope" })).toBeNull();
  });
});

describe("precomputeZoneRoutes", () => {
  it("stores a route for every ordered pair, skips stored ones, retries and reports failures", async () => {
    const zones = await prisma.zone.findMany({ orderBy: { name: "asc" } });
    const n = zones.length;
    expect(n).toBeGreaterThanOrEqual(3);
    const calls: string[] = [];
    let flaky = 0;

    const report = await precomputeZoneRoutes(prisma, {
      provider: "test" as never,
      onlyMissing: false,
      minIntervalMs: 0,
      sleep: async () => {},
      fetchOne: async (from, to) => {
        calls.push(`${from.latitude}>${to.latitude}`);
        // The first pair fails twice with a 503, then works.
        if (calls.length <= 2 && flaky++ < 2) throw new RoutingHttpError(503, "busy");
        // One pair has no route at all (a 4xx is not retried).
        const same = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
          a.latitude === b.latitude && a.longitude === b.longitude;
        if (same(from, zones[n - 2]!) && same(to, zones[n - 1]!)) throw new RoutingHttpError(400, "no road");
        return { polyline: "_p~iF~ps|U", distanceMeters: 100, durationSeconds: 30 };
      },
    });

    expect(report.pairs).toBe(n * (n - 1));
    expect(report.saved).toBe(n * (n - 1) - 1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.error).toMatch(/HTTP 400/);
    expect(await prisma.zoneRoute.count({ where: { provider: "test" } })).toBe(n * (n - 1) - 1);

    const again = await precomputeZoneRoutes(prisma, {
      provider: "test" as never,
      onlyMissing: true,
      minIntervalMs: 0,
      sleep: async () => {},
      fetchOne: async () => ({ polyline: "x", distanceMeters: 1, durationSeconds: 1 }),
    });
    expect(again).toMatchObject({ saved: 1, skipped: n * (n - 1) - 1, failed: [] });
  });
});
