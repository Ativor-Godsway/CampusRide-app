import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PointRoute, ZoneRoute } from "@prisma/client";
import { decodePolyline, isInServiceArea } from "@rida/shared";
import { prisma } from "../db/prisma";
import { campusZoneRoute, precomputeZoneRoutes } from "./zoneRoutes";
import { clearPointRoutes } from "./clearPointRoutes";

/**
 * Runs against the test database's zones and puts ZoneRoute and PointRoute
 * back afterwards (test files run one at a time: vitest.config.ts).
 */
let zoneRoutes: ZoneRoute[] = [];
let pointRoutes: PointRoute[] = [];

beforeEach(async () => {
  zoneRoutes = await prisma.zoneRoute.findMany();
  pointRoutes = await prisma.pointRoute.findMany();
});

afterEach(async () => {
  await prisma.zoneRoute.deleteMany({});
  if (zoneRoutes.length) await prisma.zoneRoute.createMany({ data: zoneRoutes });
  await prisma.pointRoute.deleteMany({});
  if (pointRoutes.length) await prisma.pointRoute.createMany({ data: pointRoutes });
});

describe("campusZoneRoute", () => {
  it("is a road on campus between two zone centres", () => {
    const balme = { latitude: 5.652012, longitude: -0.187048 };
    const akuafo = { latitude: 5.649357, longitude: -0.186087 };
    const route = campusZoneRoute(balme, akuafo)!;
    expect(route.distanceMeters).toBeGreaterThan(200);
    expect(decodePolyline(route.polyline).every((p) => isInServiceArea(p))).toBe(true);
  });
});

describe("precomputeZoneRoutes", () => {
  it("dry run: works out every ordered pair and writes nothing", async () => {
    const n = await prisma.zone.count({ where: { retiredAt: null } });
    const before = await prisma.zoneRoute.findMany({ orderBy: { id: "asc" } });

    const report = await precomputeZoneRoutes(prisma, { apply: false });

    expect(report.pairs).toBe(n * (n - 1));
    expect(report.routed + report.failed.length).toBe(report.pairs);
    expect(report.applied).toBe(false);
    expect(await prisma.zoneRoute.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });

  it("--apply: a campus route for each pair, and an old route removed where there is none", async () => {
    const zones = await prisma.zone.findMany({ where: { retiredAt: null }, orderBy: { name: "asc" } });
    const n = zones.length;
    expect(n).toBeGreaterThanOrEqual(3);
    // An old OSRM route for the pair the campus roads "can't" join below.
    const [a, b] = [zones[n - 2]!, zones[n - 1]!];
    await prisma.zoneRoute.upsert({
      where: { fromZoneId_toZoneId: { fromZoneId: a.id, toZoneId: b.id } },
      update: { polyline: "x", distanceMeters: 1, durationSeconds: 1, provider: "osrm" },
      create: { fromZoneId: a.id, toZoneId: b.id, polyline: "x", distanceMeters: 1, durationSeconds: 1, provider: "osrm" },
    });

    const report = await precomputeZoneRoutes(prisma, {
      apply: true,
      routeOne: (from, to) =>
        from.latitude === a.latitude && to.latitude === b.latitude && from.longitude === a.longitude && to.longitude === b.longitude
          ? null
          : { polyline: "_p~iF~ps|U", distanceMeters: 100, durationSeconds: 30 },
    });

    expect(report).toMatchObject({ pairs: n * (n - 1), routed: n * (n - 1) - 1, applied: true });
    expect(report.before.osrm).toBeGreaterThanOrEqual(1);
    expect(report.failed).toEqual([{ from: a.name, to: b.name }]);
    expect(await prisma.zoneRoute.count({ where: { provider: "campus" } })).toBe(n * (n - 1) - 1);
    expect(await prisma.zoneRoute.count({ where: { fromZoneId: a.id, toZoneId: b.id } })).toBe(0);
  });

  it("never routes to or from a retired zone", async () => {
    const retired = await prisma.zone.create({
      data: { name: `Retired ${Date.now()}`, quadrant: "SOUTH", latitude: 5.6505, longitude: -0.19, retiredAt: new Date() },
    });
    try {
      const touched: number[] = [];
      await precomputeZoneRoutes(prisma, {
        apply: false,
        routeOne: (from, to) => {
          touched.push(from.latitude, to.latitude);
          return null;
        },
      });
      expect(touched).not.toContain(5.6505);
    } finally {
      await prisma.zone.delete({ where: { id: retired.id } });
    }
  });
});

describe("clearPointRoutes", () => {
  it("counts the stored OSRM routes in a dry run, and deletes them all with --apply", async () => {
    await prisma.pointRoute.createMany({
      data: [
        { key: `test-${Date.now()}-1`, polyline: "x", distanceMeters: 1, durationSeconds: 1, provider: "osrm" },
        { key: `test-${Date.now()}-2`, polyline: "x", distanceMeters: 1, durationSeconds: 1, provider: "osrm" },
      ],
    });
    const rows = await prisma.pointRoute.count();

    const dry = await clearPointRoutes(prisma, false);
    expect(dry).toMatchObject({ rows, deleted: 0 });
    expect(dry.byProvider.osrm).toBeGreaterThanOrEqual(2);
    expect(await prisma.pointRoute.count()).toBe(rows);

    expect(await clearPointRoutes(prisma, true)).toMatchObject({ rows, deleted: rows });
    expect(await prisma.pointRoute.count()).toBe(0);
  });
});
