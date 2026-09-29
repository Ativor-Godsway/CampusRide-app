import { describe, it, expect } from "vitest";
import type { Zone } from "../types/zone";
import { placeSuggestions, recentDestinations } from "./placeSuggestions";

function zone(id: string, name: string): Zone {
  return { id, name, quadrant: "CENTRAL", latitude: 5.65, longitude: -0.18 };
}

const balme = zone("balme", "Balme Library");
const gate = zone("gate", "Main Gate");
const business = zone("biz", "School of Business");
const akuafo = zone("akuafo", "Akuafo Hall");
const legon = zone("legon", "Legon Hall");
const ZONES = [balme, gate, business, akuafo, legon];

describe("recentDestinations", () => {
  it("returns drop-offs newest first, each zone once", () => {
    const rides = [
      { createdAt: "2026-09-01T10:00:00Z", dropoffZone: akuafo },
      { createdAt: "2026-09-03T10:00:00Z", dropoffZone: legon },
      { createdAt: "2026-09-02T10:00:00Z", dropoffZone: legon },
      { createdAt: "2026-09-04T10:00:00Z", dropoffZone: balme },
    ];
    expect(recentDestinations(rides).map((z) => z.id)).toEqual(["balme", "legon", "akuafo"]);
  });

  it("respects the limit and copes with no rides", () => {
    const rides = ZONES.map((z, i) => ({ createdAt: new Date(2026, 0, i + 1), dropoffZone: z }));
    expect(recentDestinations(rides, 2)).toHaveLength(2);
    expect(recentDestinations([])).toEqual([]);
  });
});

describe("placeSuggestions", () => {
  it("with no query: recent, then popular landmarks that exist", () => {
    const result = placeSuggestions({
      zones: ZONES,
      recent: [akuafo],
      query: "",
      popularNames: ["Balme Library", "Night Market", "Main Gate"],
    });
    expect(result.recent).toEqual([akuafo]);
    // "Night Market" isn't a zone, so it's skipped.
    expect(result.places).toEqual([balme, gate]);
    expect(result.noMatch).toBe(false);
  });

  it("never lists a zone twice", () => {
    const result = placeSuggestions({
      zones: ZONES,
      recent: [balme],
      query: "",
      popularNames: ["Balme Library", "Main Gate"],
    });
    expect(result.places).toEqual([gate]);
  });

  it("filters both sections as the rider types, case-insensitively", () => {
    const result = placeSuggestions({ zones: ZONES, recent: [legon, akuafo], query: "  HALL " });
    expect(result.recent).toEqual([legon, akuafo]);
    expect(result.places).toEqual([]);
  });

  it("while typing, can reach any zone — not only the popular ones — starts-with first", () => {
    const result = placeSuggestions({ zones: ZONES, recent: [], query: "b" });
    // "Balme Library" starts with b; "School of Business" only contains it.
    expect(result.places.map((z) => z.id)).toEqual(["balme", "biz"]);
  });

  it("leaves out the zone chosen for the other end of the trip", () => {
    const result = placeSuggestions({
      zones: ZONES,
      recent: [balme],
      query: "",
      excludeZoneId: "balme",
      popularNames: ["Balme Library", "Main Gate"],
    });
    expect(result.recent).toEqual([]);
    expect(result.places).toEqual([gate]);
  });

  it("reports no match only when a query found nothing", () => {
    expect(placeSuggestions({ zones: ZONES, recent: [], query: "zzz" }).noMatch).toBe(true);
    expect(placeSuggestions({ zones: [], recent: [], query: "" }).noMatch).toBe(false);
  });

  it("caps the list", () => {
    expect(
      placeSuggestions({ zones: ZONES, recent: [], query: "a", limit: 2 }).places,
    ).toHaveLength(2);
  });
});
