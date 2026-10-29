import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Place } from "@prisma/client";
import { CAMPUS_GATES, nearestZone } from "@rida/shared";
import { prisma } from "../../db/prisma";
import { campusOnlyPlaces } from "./campusOnly";

/**
 * Runs against the test database's places and puts every one back afterwards
 * (test files run one at a time: vitest.config.ts, fileParallelism false).
 */
const MARK = `campus-only-test-${Date.now()}`;
let snapshot: Place[] = [];

beforeEach(async () => {
  snapshot = await prisma.place.findMany();
});

afterEach(async () => {
  await prisma.place.deleteMany({ where: { id: { notIn: snapshot.map((p) => p.id) } } });
  for (const { id, createdAt: _c, updatedAt: _u, ...data } of snapshot) {
    await prisma.place.update({ where: { id }, data });
  }
});

async function place(name: string, latitude: number, longitude: number, source: string | null) {
  const zones = await prisma.zone.findMany({ where: { retiredAt: null } });
  return prisma.place.create({
    data: { name, latitude, longitude, category: "LANDMARK", zoneId: nearestZone(latitude, longitude, zones)!.id, source },
  });
}

describe("campusOnlyPlaces", () => {
  it("dry run: reports the gates and the places outside the area, changes nothing", async () => {
    const outside = await place(`Legon City Mall ${MARK}`, 5.653443, -0.178819, `osm:${MARK}/mall`);
    const before = await prisma.place.findMany({ orderBy: { id: "asc" } });

    const report = await campusOnlyPlaces(prisma, false);

    expect(report.actions).toContainEqual(expect.objectContaining({ kind: "deactivate", name: outside.name }));
    expect(report.actions.filter((a) => a.kind !== "deactivate")).toHaveLength(CAMPUS_GATES.length - report.gatesInPlace);
    expect(await prisma.place.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });

  it("moves the gates inside, keeping their ids; hides what's outside; leaves campus places alone", async () => {
    // The old Main Gate place, at the bus stop on J.J. Rawlings Avenue.
    await prisma.place.deleteMany({ where: { source: { in: CAMPUS_GATES.map((g) => g.source) } } });
    const oldMain = await place("Main Gate", 5.65017, -0.17896, "manual:main-gate");
    const outside = await place(`Legon City Mall ${MARK}`, 5.653443, -0.178819, `osm:${MARK}/mall`);
    const byAdmin = await place(`Shop on the Avenue ${MARK}`, 5.6505, -0.1797, null);
    const campus = await place(`Balme ${MARK}`, 5.65201, -0.18705, `osm:${MARK}/balme`);

    const report = await campusOnlyPlaces(prisma, true);

    const main = await prisma.place.findUniqueOrThrow({ where: { id: oldMain.id } });
    expect(main).toMatchObject({ name: "Main Gate (inside)", latitude: 5.6503, longitude: -0.18139, category: "GATE", isActive: true });
    for (const gate of CAMPUS_GATES) {
      const row = await prisma.place.findUniqueOrThrow({ where: { source: gate.source } });
      expect(row).toMatchObject({ name: gate.name, ...gate.inside, isActive: true });
    }
    expect(report.actions).toContainEqual(expect.objectContaining({ kind: "update-gate", name: "Main Gate (inside)" }));
    expect((await prisma.place.findUniqueOrThrow({ where: { id: outside.id } })).isActive).toBe(false);
    expect((await prisma.place.findUniqueOrThrow({ where: { id: byAdmin.id } })).isActive).toBe(false);
    expect((await prisma.place.findUniqueOrThrow({ where: { id: campus.id } })).isActive).toBe(true);

    // A second run has nothing to do.
    const again = await campusOnlyPlaces(prisma, true);
    expect(again.actions).toEqual([]);
    expect(again.gatesInPlace).toBe(CAMPUS_GATES.length);
  });
});
