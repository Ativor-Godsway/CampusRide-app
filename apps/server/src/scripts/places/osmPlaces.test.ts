import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAMPUS_GATES, isInServiceArea } from "@rida/shared";
import {
  MANUAL_PLACES,
  PLACES_CSV,
  buildPlaceRows,
  categorize,
  fromCsv,
  splitAbbreviation,
  toCsv,
  type OsmElement,
} from "./osmPlaces";

const way = (id: number, tags: Record<string, string>, lat = 5.65, lon = -0.187): OsmElement => ({
  type: "way",
  id,
  center: { lat, lon },
  tags,
});

describe("categorize", () => {
  it("sorts OSM features into place categories", () => {
    expect(categorize({ name: "Volta Hall", tourism: "hostel" })).toBe("HALL");
    expect(categorize({ name: "Pentagon Block A", tourism: "hostel" })).toBe("HOSTEL");
    expect(categorize({ name: "Night Market", amenity: "marketplace" })).toBe("FOOD");
    expect(categorize({ name: "Department of Physics", building: "detached" })).toBe("FACULTY");
    expect(categorize({ name: "James Quartey Building", building: "apartments" })).toBe("FACULTY");
    expect(categorize({ name: "Balme Library", amenity: "library" })).toBe("LANDMARK");
    expect(categorize({ name: "Jubilee Circle", highway: "tertiary", junction: "roundabout" })).toBe("LANDMARK");
  });

  it("leaves out roads, bus stops, rooms and fixtures", () => {
    expect(categorize({ name: "University Avenue", highway: "tertiary" })).toBeNull();
    expect(categorize({ name: "Legon Station", highway: "bus_stop" })).toBeNull();
    expect(categorize({ name: "Block B", building: "yes" })).toBeNull();
    expect(categorize({ name: "NNB Washroom", amenity: "toilets", building: "yes" })).toBeNull();
    expect(categorize({ name: "GCB Bank", amenity: "atm" })).toBeNull();
    expect(categorize({ name: "Great Hall", building: "yes" })).toBe("LANDMARK"); // not a residence hall
    expect(categorize({ name: "Anglican Church Legon Hall", amenity: "place_of_worship", building: "yes" })).toBe("LANDMARK");
  });
});

describe("splitAbbreviation", () => {
  it("turns a trailing abbreviation into an alias", () => {
    expect(splitAbbreviation("James Quartey Building, JQB")).toEqual({ name: "James Quartey Building", alias: "JQB" });
    expect(splitAbbreviation("International Students Hostel 1, ISH 1")).toEqual({ name: "International Students Hostel 1", alias: "ISH 1" });
    expect(splitAbbreviation("Faculty of Arts, Languages")).toEqual({ name: "Faculty of Arts, Languages", alias: null });
  });
});

describe("buildPlaceRows", () => {
  it("renames, aliases, merges duplicates nearby and adds the gates", () => {
    const rows = buildPlaceRows(
      [
        way(1, { name: "The Balme Library", amenity: "library" }),
        way(2, { name: "Balme Library", building: "yes" }, 5.6501, -0.187), // ~11 m: same place
        way(3, { name: "Commonwealth Hall", tourism: "hostel" }, 5.6508, -0.1927),
        way(4, { name: "Somewhere", highway: "residential" }),
        way(5, { name: "Far Away Cafe", amenity: "cafe" }, 6.6885, -1.6244), // outside the area
      ],
      [],
    );
    const names = rows.map((r) => r.name);
    expect(names.filter((n) => n === "Balme Library")).toHaveLength(1);
    expect(rows.find((r) => r.name === "Balme Library")).toMatchObject({ source: "osm:way/1", aliases: expect.arrayContaining(["Balme"]) });
    expect(rows.find((r) => r.name === "Commonwealth Hall")!.aliases).toContain("Vandals");
    expect(names).not.toContain("Somewhere");
    expect(names).not.toContain("Far Away Cafe");
    for (const gate of MANUAL_PLACES) expect(names).toContain(gate.name);
  });
});

describe("the CSV", () => {
  it("round-trips, quoting what needs it", () => {
    const rows = buildPlaceRows([way(1, { name: 'Bob\'s "Best", Kitchen', amenity: "restaurant" })], []);
    expect(fromCsv(toCsv(rows))).toEqual(rows);
  });

  it("refuses a malformed row with its line number", () => {
    expect(() => fromCsv("name,category,latitude,longitude,aliases,source,note\nX,PALACE,5.65,-0.187,,s,\n")).toThrow(/line 2: unknown category/);
    expect(() => fromCsv("name,category,latitude,longitude,aliases,source,note\nX,FOOD,6.68,-1.62,,s,\n")).toThrow(/outside the service area/);
  });

  it("the committed list has 100–200 places, each inside the area, each source once", () => {
    const rows = fromCsv(readFileSync(PLACES_CSV, "utf8"));
    expect(rows.length).toBeGreaterThanOrEqual(100);
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(rows.every((r) => isInServiceArea(r))).toBe(true);
    expect(new Set(rows.map((r) => r.source)).size).toBe(rows.length);
    const names = rows.map((r) => r.name);
    for (const must of ["Balme Library", "Commonwealth Hall", "Night Market", "Main Gate (inside)", "Stadium Gate", "TF Gate"]) {
      expect(names).toContain(must);
    }
    // 2026-10-29: J.J. Rawlings Avenue and everything east of it are not served.
    for (const gone of ["Main Gate", "Okponglo Gate", "University of Ghana Hospital", "Legon City Mall", "Legon Police Station"]) {
      expect(names).not.toContain(gone);
    }
    // The owner's review, 2026-10-12: campus only, International House gone, no "West Gate".
    for (const gone of ["Accra Mall", "Accra Mall Roundabout", "Atomic Junction", "Okponglo", "Shiashie", "Tetteh Quarshie Interchange", "UPS Junction", "International House"]) {
      expect(names).not.toContain(gone);
    }
    expect(rows.find((r) => r.name === "Legon Barrier")!.aliases).toEqual(["Barrier"]);
  });

  it("lists every campus gate at its inside point (CAMPUS_GATES)", () => {
    const rows = fromCsv(readFileSync(PLACES_CSV, "utf8"));
    for (const gate of CAMPUS_GATES) {
      const row = rows.find((r) => r.source === gate.source);
      expect(row, gate.name).toMatchObject({
        name: gate.name,
        category: "GATE",
        latitude: gate.inside.latitude,
        longitude: gate.inside.longitude,
        aliases: [...gate.aliases],
      });
    }
  });
});
