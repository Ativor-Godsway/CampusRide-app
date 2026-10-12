import { describe, expect, it } from "vitest";
import {
  PINNED_LOCATION_LABEL,
  editDistance,
  labelForPoint,
  nearestPlace,
  normalizeSearchText,
  placeMatchScore,
  searchPlaces,
} from "./campusPlaces";

const places = [
  { id: "balme", name: "Balme Library", aliases: ["Balme", "Main Library"], latitude: 5.65201, longitude: -0.18705 },
  { id: "night", name: "Night Market", aliases: [], latitude: 5.64208, longitude: -0.1856 },
  { id: "cw", name: "Commonwealth Hall", aliases: ["Vandals", "Commonwealth"], latitude: 5.6508, longitude: -0.19267 },
  { id: "ugbs", name: "University of Ghana Business School", aliases: ["UGBS", "Business School"], latitude: 5.65281, longitude: -0.18863 },
  { id: "volta", name: "Volta Hall", aliases: [], latitude: 5.6515, longitude: -0.18969 },
  { id: "voltacafe", name: "Volta Café", aliases: [], latitude: 5.65166, longitude: -0.18945 },
  { id: "akuafo", name: "Akuafo Hall", aliases: ["Akuafo"], latitude: 5.64936, longitude: -0.18609 },
  { id: "legon", name: "Legon Hall", aliases: [], latitude: 5.64937, longitude: -0.188 },
  { id: "legonA", name: "Legon Hall Annex A", aliases: [], latitude: 5.64798, longitude: -0.18841 },
  { id: "hallLib", name: "Hall Library", aliases: [], latitude: 5.64643, longitude: -0.18729 },
];
const ids = (q: string) => searchPlaces(places, q).map((p) => p.id);

describe("normalizeSearchText", () => {
  it("drops case, accents and punctuation", () => {
    expect(normalizeSearchText("  Volta Café, (VH) ")).toBe("volta cafe vh");
  });
});

describe("editDistance", () => {
  it("counts edits, with a swap as one", () => {
    expect(editDistance("market", "markte")).toBe(1);
    expect(editDistance("commonweath", "commonwealth")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abcdefgh", "zzzzzzzz", 2)).toBe(3);
  });
});

describe("searchPlaces", () => {
  it("matches names and aliases, from the start of any word", () => {
    expect(ids("balme")[0]).toBe("balme");
    expect(ids("main lib")[0]).toBe("balme");
    expect(ids("ugbs")[0]).toBe("ugbs");
    expect(ids("business")).toContain("ugbs");
    expect(ids("vandals")).toEqual(["cw"]);
  });

  it("tolerates typos", () => {
    expect(ids("commonweath")[0]).toBe("cw");
    expect(ids("night markt")[0]).toBe("night");
    expect(ids("nigt market")[0]).toBe("night");
    expect(ids("balm librray")[0]).toBe("balme");
    expect(ids("akwafo")[0]).toBe("akuafo");
  });

  it("puts an exact name first, then names that start with the query", () => {
    expect(ids("legon hall").slice(0, 2)).toEqual(["legon", "legonA"]);
    expect(ids("hall")[0]).toBe("hallLib");
    expect(ids("volta cafe")[0]).toBe("voltacafe");
  });

  it("finds nothing for an empty query or nonsense, and doesn't over-fuzz short words", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("zzzzqqq")).toEqual([]);
    expect(placeMatchScore(places[1]!, "nit")).toBe(0);
  });
});

describe("labels for a pin", () => {
  it("names the place when the pin is at it, says Near within 250 m, else Pinned location", () => {
    expect(labelForPoint({ latitude: 5.65203, longitude: -0.18706 }, places)).toBe("Balme Library");
    expect(labelForPoint({ latitude: 5.6531, longitude: -0.18705 }, places)).toBe("Near Balme Library"); // ~120 m
    expect(labelForPoint({ latitude: 5.66, longitude: -0.2 }, places)).toBe(PINNED_LOCATION_LABEL);
    expect(labelForPoint({ latitude: 5.66, longitude: -0.2 }, [])).toBe(PINNED_LOCATION_LABEL);
  });

  it("nearestPlace reports the distance", () => {
    const near = nearestPlace({ latitude: 5.64208, longitude: -0.1856 }, places);
    expect(near?.place.id).toBe("night");
    expect(near?.meters).toBeLessThan(1);
  });
});
