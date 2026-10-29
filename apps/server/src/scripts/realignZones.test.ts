import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Zone } from "@prisma/client";
import { isInServiceArea } from "@rida/shared";
import { prisma } from "../db/prisma";
import { REAL_ZONE_CENTRES, RENAMED_ZONES, RETIRED_ZONES, isAlreadyAligned, realignZones } from "./realignZones";
import { createTestDriver, cleanupDriver } from "../services/ride/testFixtures";
import { SCRIPT_TX_OPTIONS } from "./scriptTx";

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
  vi.restoreAllMocks();
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
      renamedFrom: null,
    });
    expect(report.actions.find((a) => a.name === "James Topp Nelson Yankah Hall (TF Hall)")).toMatchObject({
      kind: "move",
      renamedFrom: null,
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
      expect(zones.some((z) => z.name === "UG Medical Centre (UGMC)")).toBe(true);
      for (const [name, real] of Object.entries(REAL_ZONE_CENTRES)) {
        expect(zones.find((z) => z.name === name)).toMatchObject({ latitude: real.latitude, longitude: real.longitude });
      }
      const botanical = snapshot.find((z) => z.name === "James Topp Nelson Yankah Hall (TF Hall)")!;
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

  it("keeps the transaction short and gives it room: long timeout, one statement per zone, not per place", async () => {
    // Many places that all change zone: grouped, they cost one statement per target zone.
    const accra = snapshot.find((z) => z.name === "Accra Mall Junction")!;
    await prisma.place.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        name: `Spot ${i}`,
        latitude: 5.64 + i * 0.0008,
        longitude: -0.187,
        zoneId: accra.id,
        source: `${MARK}:many:${i}`,
      })),
    });

    let options: unknown;
    let statements = 0;
    const real = prisma.$transaction.bind(prisma) as (fn: unknown, opts?: unknown) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
      options = opts;
      return real(async (tx: Record<string, unknown>) => {
        const counting = new Proxy(tx, {
          get(target, model) {
            const delegate = target[model as string];
            if (typeof delegate !== "object" || delegate === null) return delegate;
            return new Proxy(delegate as Record<string, unknown>, {
              get(d, method) {
                const f = d[method as string];
                return typeof f === "function" ? (...args: unknown[]) => (statements++, (f as (...a: unknown[]) => unknown).apply(d, args)) : f;
              },
            });
          },
        });
        return fn(counting);
      }, opts);
    }) as never);

    const report = await realignZones(prisma, true);
    expect(options).toEqual(SCRIPT_TX_OPTIONS);
    expect(report.placesRezoned).toBeGreaterThanOrEqual(30);
    const zonesChanged = report.actions.filter((a) => a.kind !== "leave").length;
    const zoneCount = snapshot.length;
    // Changed zones + at most one updateMany per target zone for places and for drivers.
    expect(statements).toBeLessThanOrEqual(zonesChanged + 2 * zoneCount);
    expect(statements).toBeLessThan(report.placesRezoned);
  });
});

describe("REAL_ZONE_CENTRES", () => {
  it("are all inside the service area (the Main Gate zone sits inside the gate)", () => {
    for (const [name, centre] of Object.entries(REAL_ZONE_CENTRES)) {
      expect(isInServiceArea(centre), name).toBe(true);
    }
  });
});
