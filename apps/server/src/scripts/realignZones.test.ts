import { describe, expect, it } from "vitest";
import { prisma } from "../db/prisma";
import { REAL_ZONE_CENTRES, realignZones } from "./realignZones";

describe("realignZones (dry run)", () => {
  it("reports how far each seeded zone would move, and changes nothing", async () => {
    const before = await prisma.zone.findMany({ orderBy: { id: "asc" } });
    const report = await realignZones(prisma, false);
    expect(report.moves.length + report.unknown.length).toBe(before.length);
    for (const move of report.moves) expect(REAL_ZONE_CENTRES[move.name]).toBeDefined();
    expect(report.placesRezoned).toBe(0);
    expect(await prisma.zone.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });
});
