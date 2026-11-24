import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Zone } from "@prisma/client";
import { zonePairKey } from "@rida/shared";
import { prisma } from "../db/prisma";
import { getEligibleDrivers } from "../services/ride/dispatch";
import { cleanupDriver, createTestDriver } from "../services/ride/testFixtures";
import { replaceZoneNeighbours, suggestedZoneNeighbours, ZoneNeighbourError } from "../services/zones/zoneNeighbours";
import { checkZoneAdjacency, describeReport, linkZones, type NamedPair } from "./zoneAdjacency";

/**
 * Zone neighbours (zones:check, zones:link, and the admin's replace) against
 * the test database. The test zones are seeded without adjacency
 * (db:seed:test), so each test adds zones of its own — two side by side
 * (neighbours), one 3 km away (nobody's neighbour by distance) and a retired
 * one — and removes every row it added afterwards (files run one at a time).
 */
const MARK = `zones-adjacency-test-${Date.now()}`;
let rowsBefore: string[] = [];
let mine: { a: Zone; b: Zone; far: Zone; retired: Zone };

const keys = (pairs: readonly NamedPair[]) => pairs.map((p) => zonePairKey(p.a.id, p.b.id));

beforeEach(async () => {
  rowsBefore = (await prisma.zoneAdjacency.findMany({ select: { id: true } })).map((r) => r.id);
  const zone = (name: string, latitude: number, longitude: number, retiredAt: Date | null = null) =>
    prisma.zone.create({ data: { name: `${MARK} ${name}`, quadrant: "CENTRAL", latitude, longitude, retiredAt } });
  mine = {
    a: await zone("A", 5.6502, -0.187),
    b: await zone("B", 5.6506, -0.1872),
    // Inside campus, ~3 km south of A: too far for "within 800 m".
    far: await zone("far", 5.6235, -0.1885),
    retired: await zone("retired", 5.6504, -0.1871, new Date()),
  };
});

afterEach(async () => {
  await prisma.zoneAdjacency.deleteMany({ where: { id: { notIn: rowsBefore } } });
  await prisma.zone.deleteMany({ where: { name: { startsWith: MARK } } });
});

describe("the suggested neighbours", () => {
  it("pair zones whose centres are within 800 m, never a zone with a far one by distance alone, never a retired zone", async () => {
    const suggested = await suggestedZoneNeighbours(prisma);
    const pairKeys = suggested.map((p) => zonePairKey(p.a, p.b));
    expect(pairKeys).toContain(zonePairKey(mine.a.id, mine.b.id));
    expect(pairKeys).not.toContain(zonePairKey(mine.a.id, mine.far.id));
    expect(suggested.some((p) => p.a === mine.retired.id || p.b === mine.retired.id)).toBe(false);
    // A real neighbour structure, not a full mesh.
    const n = await prisma.zone.count({ where: { retiredAt: null } });
    expect(suggested.length).toBeLessThan((n * (n - 1)) / 2);
  });
});

describe("checkZoneAdjacency (zones:check)", () => {
  it("reports what is linked against the suggestion — and writes nothing", async () => {
    const rows = await prisma.zoneAdjacency.count();
    const report = await checkZoneAdjacency(prisma);
    expect(report.activeZones.map((z) => z.id)).not.toContain(mine.retired.id);
    expect(keys(report.missing)).toContain(zonePairKey(mine.a.id, mine.b.id));
    expect(report.isolated.map((z) => z.id)).toEqual(expect.arrayContaining([mine.a.id, mine.b.id]));
    expect(await prisma.zoneAdjacency.count()).toBe(rows);
  });

  it("calls out the old full mesh, a one-way row, and an extra pair", async () => {
    const zones = await prisma.zone.findMany({ where: { retiredAt: null }, select: { id: true } });
    await prisma.zoneAdjacency.createMany({
      data: zones.flatMap((x) => zones.filter((y) => y.id !== x.id).map((y) => ({ zoneId: x.id, adjacentZoneId: y.id }))),
      skipDuplicates: true,
    });
    const mesh = await checkZoneAdjacency(prisma);
    expect(mesh.fullMesh).toBe(true);
    expect(keys(mesh.extra)).toContain(zonePairKey(mine.a.id, mine.far.id));
    expect(describeReport(mesh).join("\n")).toContain("Still the old full mesh");

    await prisma.zoneAdjacency.deleteMany({ where: { zoneId: mine.b.id, adjacentZoneId: mine.a.id } });
    expect(keys((await checkZoneAdjacency(prisma)).oneWay)).toContain(zonePairKey(mine.a.id, mine.b.id));
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
});

describe("linkZones (zones:link)", () => {
  it("without --apply lists what it would change and writes nothing", async () => {
    const rows = await prisma.zoneAdjacency.count();
    const { added } = await linkZones(prisma, false);
    expect(added.map((p) => zonePairKey(p.a, p.b))).toContain(zonePairKey(mine.a.id, mine.b.id));
    expect(await prisma.zoneAdjacency.count()).toBe(rows);
  });

  it("with --apply replaces a full mesh with the suggested pairs, both ways; a second run changes nothing; retired rows stay", async () => {
    const zones = await prisma.zone.findMany({ where: { retiredAt: null }, select: { id: true } });
    await prisma.zoneAdjacency.createMany({
      data: zones.flatMap((x) => zones.filter((y) => y.id !== x.id).map((y) => ({ zoneId: x.id, adjacentZoneId: y.id }))),
      skipDuplicates: true,
    });
    await prisma.zoneAdjacency.create({ data: { zoneId: mine.retired.id, adjacentZoneId: mine.a.id } });

    const { removed } = await linkZones(prisma, true);
    expect(removed.map((p) => zonePairKey(p.a, p.b))).toContain(zonePairKey(mine.a.id, mine.far.id));
    const after = await checkZoneAdjacency(prisma);
    expect(after.missing).toEqual([]);
    expect(after.extra).toEqual([]);
    expect(after.oneWay).toEqual([]);
    expect(after.fullMesh).toBe(false);
    expect(after.activeRows).toBe(2 * after.suggested.length);
    expect(describeReport(after).join("\n")).toContain("✓ The neighbours are the suggested ones.");
    expect(await prisma.zoneAdjacency.count({ where: { zoneId: mine.retired.id } })).toBe(1);

    const again = await linkZones(prisma, true);
    expect(again.added).toEqual([]);
    expect(again.removed).toEqual([]);
  });

  it("afterwards a ride is offered to drivers in the zone next door, not to one 3 km away", async () => {
    const near = await createTestDriver({ currentZoneId: mine.b.id, isOnline: true, isApproved: true });
    const far = await createTestDriver({ currentZoneId: mine.far.id, isOnline: true, isApproved: true });
    try {
      await linkZones(prisma, true);
      const reach = (await getEligibleDrivers(prisma, { pickupZoneId: mine.a.id })).map((d) => d.userId);
      expect(reach).toContain(near.user.id);
      expect(reach).not.toContain(far.user.id);
    } finally {
      await cleanupDriver(near.user.id);
      await cleanupDriver(far.user.id);
    }
  });
});

describe("replaceZoneNeighbours (admin site)", () => {
  it("refuses a zone left with no neighbour, a retired zone and a zone paired with itself", async () => {
    const suggested = (await suggestedZoneNeighbours(prisma)).map((p) => ({ a: p.a, b: p.b }));
    const withoutA = suggested.filter((p) => p.a !== mine.a.id && p.b !== mine.a.id);
    await expect(replaceZoneNeighbours(prisma, withoutA)).rejects.toThrow(ZoneNeighbourError);
    await expect(replaceZoneNeighbours(prisma, [...suggested, { a: mine.a.id, b: mine.retired.id }])).rejects.toThrow(/in service/);
    await expect(replaceZoneNeighbours(prisma, [...suggested, { a: mine.a.id, b: mine.a.id }])).rejects.toThrow(/own neighbour/);
  });

  it("audit-logs what an admin changed", async () => {
    const admin = await prisma.user.findFirst({ select: { id: true } });
    const suggested = (await suggestedZoneNeighbours(prisma)).map((p) => ({ a: p.a, b: p.b }));
    await replaceZoneNeighbours(prisma, suggested);
    await replaceZoneNeighbours(prisma, [...suggested, { a: mine.a.id, b: mine.far.id }], { adminId: admin!.id });
    const log = await prisma.adminAuditLog.findFirst({ where: { action: "zones.neighbours" }, orderBy: { timestamp: "desc" } });
    expect(log?.reason).toContain(`${mine.a.name} – ${mine.far.name}`);
    await prisma.adminAuditLog.deleteMany({ where: { id: log!.id } });
  });
});
