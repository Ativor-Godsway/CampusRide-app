import { afterEach, describe, expect, it } from "vitest";
import { nearestZone } from "@rida/shared";
import { prisma } from "../../db/prisma";
import { seedPlaces } from "./seedPlaces";
import type { PlaceRow } from "./osmPlaces";

const MARK = `seed-test-${Date.now()}`;
const row = (name: string, latitude: number, longitude: number): PlaceRow => ({
  name,
  category: "LANDMARK",
  latitude,
  longitude,
  aliases: ["alias"],
  source: `osm:${MARK}/${name}`,
  note: "",
});

afterEach(async () => {
  await prisma.place.deleteMany({ where: { source: { contains: MARK } } });
});

describe("seedPlaces", () => {
  it("creates places with their nearest zone, and leaves them alone on a re-run", async () => {
    const zones = await prisma.zone.findMany();
    const rows = [row("A", 5.65201, -0.18705), row("B", 5.62218, -0.17326)];
    const first = await seedPlaces(prisma, rows);
    expect(first.created).toEqual(["A", "B"]);
    const b = await prisma.place.findFirstOrThrow({ where: { source: rows[1]!.source } });
    expect(b.zoneId).toBe(nearestZone(5.62218, -0.17326, zones)!.id);

    // An admin renamed A; a re-run must not undo that.
    await prisma.place.updateMany({ where: { source: rows[0]!.source }, data: { name: "A (renamed)" } });
    const again = await seedPlaces(prisma, rows);
    expect(again).toMatchObject({ created: [], unchanged: 2 });
    expect((await prisma.place.findFirstOrThrow({ where: { source: rows[0]!.source } })).name).toBe("A (renamed)");

    expect((await seedPlaces(prisma, rows, { update: true })).updated).toEqual(["A", "B"]);
    expect((await prisma.place.findFirstOrThrow({ where: { source: rows[0]!.source } })).name).toBe("A");
  });

  it("reports (and optionally deactivates) seeded places dropped from the list; a dry run writes nothing", async () => {
    await seedPlaces(prisma, [row("Keep", 5.65201, -0.18705), row("Drop", 5.6515, -0.18969)]);
    const dry = await seedPlaces(prisma, [row("Keep", 5.65201, -0.18705), row("New", 5.64208, -0.1856)], {
      dryRun: true,
      deactivateMissing: true,
    });
    expect(dry.created).toEqual(["New"]);
    expect(dry.missing).toContain("Drop");
    expect(await prisma.place.count({ where: { source: { contains: MARK } } })).toBe(2);

    await seedPlaces(prisma, [row("Keep", 5.65201, -0.18705)], { deactivateMissing: true });
    expect((await prisma.place.findFirstOrThrow({ where: { name: "Drop", source: { contains: MARK } } })).isActive).toBe(false);
  });
});
