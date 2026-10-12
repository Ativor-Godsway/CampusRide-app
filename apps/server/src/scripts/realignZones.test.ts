import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Zone } from "@prisma/client";
import { prisma } from "../db/prisma";
import { REAL_ZONE_CENTRES, RENAMED_ZONES, RETIRED_ZONES, isAlreadyAligned, realignZones } from "./realignZones";
import { createTestDriver, cleanupDriver } from "../services/ride/testFixtures";

/**
 * Runs against the seeded test zones and puts every one back afterwards
 * (test files run one at a time: vitest.config.ts, fileParallelism false).
 */
let snapshot: Zone[] = [];
const MARK = `realign-test-${Date.now()}`;

beforeEach(async () => {
  snapshot = await prisma.zone.findMany();
});

afterEach(async () => {
  for (const z of snapshot) {
    await prisma.zone.update({
      where: { id: z.id },
      data: { name: z.name, latitude: z.latitude, longitude: z.longitude, retiredAt: z.retiredAt },
    });
  }
  await prisma.place.deleteMany({ where: { source: { startsWith: MARK } } });
});

describe("realignZones", () => {
  it("a dry run reports every zone and changes nothing", async () => {
    const report = await realignZones(prisma, false);
    expect(report.actions).toHaveLength(snapshot.length);
    expect(report.actions.find((a) => a.name === "Accra Mall Junction")).toMatchObject({ kind: "retire", already: false });
    expect(report.actions.find((a) => a.name === "UG Medical Centre (UGMC)")).toMatchObject({
      kind: "move",
      renamedFrom: "Medical School (UGMS)",
    });
    expect(report.actions.find((a) => a.name === "James Topp Nelson Yankah Hall (TF Hall)")).toMatchObject({
      kind: "move",
      renamedFrom: "Botanical Gardens Gate",
    });
    expect(report.actions.some((a) => a.kind === "leave")).toBe(false);
    expect(await prisma.zone.findMany()).toEqual(expect.arrayContaining(snapshot));
  });

  it("retires, renames and moves; recomputes places and stranded drivers; a second run changes nothing", async () => {
    const accra = snapshot.find((z) => z.name === "Accra Mall Junction")!;
    // A place right at the old (fake) Accra Mall Junction centre, and a driver "in" that zone.
    const place = await prisma.place.create({
      data: { name: "Test spot", latitude: accra.latitude, longitude: accra.longitude, zoneId: accra.id, source: `${MARK}:spot` },
    });
    const { user } = await createTestDriver({ currentZoneId: accra.id });

    try {
      const report = await realignZones(prisma, true);
      expect(report.driversMoved).toBe(1);

      const zones = await prisma.zone.findMany();
      const retired = zones.find((z) => z.id === accra.id)!;
      expect(retired.retiredAt).not.toBeNull();
      expect(retired.latitude).toBe(accra.latitude); // retired zones aren't moved
      const ugmc = zones.find((z) => z.name === "UG Medical Centre (UGMC)")!;
      expect(ugmc).toMatchObject({ latitude: 5.631864, longitude: -0.185925 });
      expect(zones.some((z) => z.name === "Medical School (UGMS)")).toBe(false);
      for (const [name, real] of Object.entries(REAL_ZONE_CENTRES)) {
        expect(zones.find((z) => z.name === name)).toMatchObject({ latitude: real.latitude, longitude: real.longitude });
      }
      const botanical = snapshot.find((z) => z.name === "Botanical Gardens Gate")!;
      expect(zones.find((z) => z.id === botanical.id)).toMatchObject({
        name: "James Topp Nelson Yankah Hall (TF Hall)",
        latitude: 5.666259,
        longitude: -0.182087,
      });

      // Nothing is left pointing at the retired zone.
      expect((await prisma.place.findUniqueOrThrow({ where: { id: place.id } })).zoneId).not.toBe(accra.id);
      const driver = await prisma.driver.findUniqueOrThrow({ where: { userId: user.id } });
      expect(driver.currentZoneId).not.toBe(accra.id);
      expect(driver.currentZoneId).not.toBeNull();

      // Idempotent.
      const again = await realignZones(prisma, false);
      expect(isAlreadyAligned(again)).toBe(true);
      const applyAgain = await realignZones(prisma, true);
      expect(applyAgain).toMatchObject({ placesRezoned: 0, driversMoved: 0 });
      expect(await prisma.zone.findMany()).toEqual(expect.arrayContaining(zones));
    } finally {
      await cleanupDriver(user.id);
    }
  });

  it("only knows zone names that exist in the seed", () => {
    const seeded = new Set(snapshot.map((z) => z.name));
    for (const name of RETIRED_ZONES) expect(seeded.has(name)).toBe(true);
    for (const from of Object.keys(RENAMED_ZONES)) expect(seeded.has(from)).toBe(true);
    for (const name of Object.keys(REAL_ZONE_CENTRES)) {
      const original = Object.entries(RENAMED_ZONES).find(([, to]) => to === name)?.[0] ?? name;
      expect(seeded.has(original)).toBe(true);
    }
  });
});
