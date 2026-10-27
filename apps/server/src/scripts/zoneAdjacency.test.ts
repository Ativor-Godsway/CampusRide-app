import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Zone } from "@prisma/client";
import { prisma } from "../db/prisma";
import { getEligibleDrivers } from "../services/ride/dispatch";
import { cleanupDriver, createTestDriver } from "../services/ride/testFixtures";
import { checkZoneAdjacency, describeReport, linkZones, type AdjacencyReport } from "./zoneAdjacency";

/**
 * zones:check and zones:link against the test database. The test zones are
 * seeded without adjacency (db:seed:test), and other files build their own
 * sparse edges, so each test adds two zones of its own (and a retired one)
 * and removes every row it added afterwards (files run one at a time:
 * vitest.config.ts, fileParallelism false).
 */
const MARK = `zones-adjacency-test-${Date.now()}`;
let rowsBefore: string[] = [];
let mine: { a: Zone; b: Zone; retired: Zone };

const pairs = (report: AdjacencyReport) => report.missing.map((m) => `${m.from.id}>${m.to.id}`);

beforeEach(async () => {
  rowsBefore = (await prisma.zoneAdjacency.findMany({ select: { id: true } })).map((r) => r.id);
  const zone = (name: string, retiredAt: Date | null = null) =>
    prisma.zone.create({
      data: { name: `${MARK} ${name}`, quadrant: "CENTRAL", latitude: 5.65, longitude: -0.187, retiredAt },
    });
  mine = { a: await zone("A"), b: await zone("B"), retired: await zone("retired", new Date()) };
});

afterEach(async () => {
  await prisma.zoneAdjacency.deleteMany({ where: { id: { notIn: rowsBefore } } });
  await prisma.zone.deleteMany({ where: { name: { startsWith: MARK } } });
});

describe("checkZoneAdjacency (zones:check)", () => {
  it("reports the zones in service, the rows and what a full mesh is missing — and writes nothing", async () => {
    const report = await checkZoneAdjacency(prisma);

    const inService = await prisma.zone.count({ where: { retiredAt: null } });
    expect(report.activeZones).toHaveLength(inService);
    expect(report.adjacencyRows).toBe(await prisma.zoneAdjacency.count());
    expect(report.fullMesh).toBe(inService * (inService - 1));
    expect(report.missing).toHaveLength(report.fullMesh - report.activeRows);
    // The two new zones have no neighbours: missing both ways, isolated.
    expect(pairs(report)).toEqual(expect.arrayContaining([`${mine.a.id}>${mine.b.id}`, `${mine.b.id}>${mine.a.id}`]));
    expect(report.isolated.map((z) => z.id)).toEqual(expect.arrayContaining([mine.a.id, mine.b.id]));
    // Retired zones are left out entirely.
    expect(report.activeZones.map((z) => z.id)).not.toContain(mine.retired.id);
    expect(report.missing.some((m) => m.from.id === mine.retired.id || m.to.id === mine.retired.id)).toBe(false);
    expect(await prisma.zoneAdjacency.count()).toBe(report.adjacencyRows);
  });

  it("counts a pair linked one way as linked for dispatch, but still missing a row", async () => {
    const before = await checkZoneAdjacency(prisma);
    await prisma.zoneAdjacency.create({ data: { zoneId: mine.a.id, adjacentZoneId: mine.b.id } });
    const after = await checkZoneAdjacency(prisma);

    expect(after.activeRows).toBe(before.activeRows + 1);
    expect(after.unlinkedPairs).toBe(before.unlinkedPairs - 1);
    expect(pairs(after)).not.toContain(`${mine.a.id}>${mine.b.id}`);
    expect(pairs(after)).toContain(`${mine.b.id}>${mine.a.id}`);
    expect(after.isolated.map((z) => z.id)).not.toContain(mine.a.id);
    expect(after.isolated.map((z) => z.id)).not.toContain(mine.b.id);
  });

  it("does not count rows to or from a retired zone", async () => {
    const before = await checkZoneAdjacency(prisma);
    await prisma.zoneAdjacency.create({ data: { zoneId: mine.retired.id, adjacentZoneId: mine.a.id } });
    const after = await checkZoneAdjacency(prisma);

    expect(after.adjacencyRows).toBe(before.adjacencyRows + 1);
    expect(after.activeRows).toBe(before.activeRows);
    expect(after.isolated.map((z) => z.id)).toContain(mine.a.id);
  });

  it("runs read-only: the database refuses a write inside its transaction", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.zoneAdjacency.create({ data: { zoneId: mine.a.id, adjacentZoneId: mine.b.id } });
      }),
    ).rejects.toThrow(/read-only transaction/);
    expect(await prisma.zoneAdjacency.count({ where: { zoneId: mine.a.id } })).toBe(0);
  });

  it("describes a gap and a full mesh in plain words", async () => {
    const report = await checkZoneAdjacency(prisma);
    const text = describeReport(report).join("\n");
    expect(text).toContain(`Zones in service:                 ${report.activeZones.length}`);
    expect(text).toContain(`Missing rows:                     ${report.missing.length}`);
    expect(text).toContain(mine.a.name);
    expect(text).toContain("Not a full mesh");

    await linkZones(prisma, true);
    const full = describeReport(await checkZoneAdjacency(prisma)).join("\n");
    expect(full).toContain("Zones with no neighbours:         none");
    expect(full).toContain("Full mesh");
  });
});

describe("linkZones (zones:link)", () => {
  it("without --apply lists what it would add and writes nothing", async () => {
    const rows = await prisma.zoneAdjacency.count();
    const { before, added } = await linkZones(prisma, false);
    expect(added).toBe(0);
    expect(before.missing).toEqual((await checkZoneAdjacency(prisma)).missing);
    expect(before.missing.length).toBeGreaterThan(0);
    expect(await prisma.zoneAdjacency.count()).toBe(rows);
  });

  it("with --apply adds only the missing rows, changes and deletes nothing, and a second run adds nothing", async () => {
    // A one-way row between zones in service, and a row to a retired zone.
    await prisma.zoneAdjacency.create({ data: { zoneId: mine.a.id, adjacentZoneId: mine.b.id } });
    await prisma.zoneAdjacency.create({ data: { zoneId: mine.retired.id, adjacentZoneId: mine.a.id } });
    const existing = await prisma.zoneAdjacency.findMany({ orderBy: { id: "asc" } });

    const { before, added } = await linkZones(prisma, true);
    expect(added).toBe(before.missing.length);
    expect(pairs(before)).not.toContain(`${mine.a.id}>${mine.b.id}`);

    const after = await checkZoneAdjacency(prisma);
    expect(after.missing).toEqual([]);
    expect(after.unlinkedPairs).toBe(0);
    expect(after.isolated).toEqual([]);
    expect(after.activeRows).toBe(after.fullMesh);
    expect(after.adjacencyRows).toBe(existing.length + added);
    // Every row that was there is still there, unchanged.
    const kept = await prisma.zoneAdjacency.findMany({ where: { id: { in: existing.map((r) => r.id) } }, orderBy: { id: "asc" } });
    expect(kept).toEqual(existing);
    // Nothing new to or from the retired zone.
    expect(
      await prisma.zoneAdjacency.count({ where: { OR: [{ zoneId: mine.retired.id }, { adjacentZoneId: mine.retired.id }] } }),
    ).toBe(1);

    const again = await linkZones(prisma, true);
    expect(again.added).toBe(0);
    expect(again.before.missing).toEqual([]);
    expect(await prisma.zoneAdjacency.count()).toBe(after.adjacencyRows);
  });

  it("afterwards a ride in one zone is offered to a driver in the zone next door", async () => {
    const { user } = await createTestDriver({ currentZoneId: mine.b.id, isOnline: true, isApproved: true });
    try {
      const reach = async () => (await getEligibleDrivers(prisma, { pickupZoneId: mine.a.id })).map((d) => d.userId);
      expect(await reach()).not.toContain(user.id);
      await linkZones(prisma, true);
      expect(await reach()).toContain(user.id);
    } finally {
      await cleanupDriver(user.id);
    }
  });
});
