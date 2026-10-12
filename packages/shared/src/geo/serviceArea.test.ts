import { describe, expect, it } from "vitest";
import {
  SERVICE_AREA_POLYGON,
  isInServiceArea,
  outsideServiceAreaMessage,
  pointInPolygon,
  zoneForPoint,
} from "./serviceArea";

const square = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
] as const;

describe("pointInPolygon", () => {
  it("is true inside and false outside", () => {
    expect(pointInPolygon({ latitude: 0.5, longitude: 0.5 }, square)).toBe(true);
    expect(pointInPolygon({ latitude: 1.5, longitude: 0.5 }, square)).toBe(false);
    expect(pointInPolygon({ latitude: 0.5, longitude: -0.1 }, square)).toBe(false);
  });
});

describe("the CampusRide service area", () => {
  const inside: Record<string, [number, number]> = {
    "Balme Library": [5.65201, -0.18705],
    "Great Hall": [5.65063, -0.19622],
    "Jean Nelson Aka Hall (south end)": [5.63534, -0.18848],
    "UG Medical Centre": [5.63186, -0.18592],
    "Pentagon hostels": [5.65765, -0.18202],
    "James Topp Nelson Yankah Hall (north end)": [5.66626, -0.18209],
    "Legon main gate / N4": [5.6505, -0.1795],
    "Okponglo": [5.64134, -0.17809],
    "Shiashie": [5.62768, -0.17644],
    "Accra Mall": [5.62218, -0.17326],
    "Accra Mall roundabout": [5.62204, -0.17473],
  };
  const outside: Record<string, [number, number]> = {
    Kumasi: [6.6885, -1.6244],
    "Madina Zongo Junction": [5.67633, -0.1779],
    "GIMPA main entrance": [5.63988, -0.20455],
    "Kwame Nkrumah Circle": [5.57, -0.21],
    "East Legon (American House)": [5.6445, -0.1623],
  };

  it.each(Object.entries(inside))("includes %s", (_, [latitude, longitude]) => {
    expect(isInServiceArea({ latitude, longitude })).toBe(true);
  });

  it.each(Object.entries(outside))("excludes %s", (_, [latitude, longitude]) => {
    expect(isInServiceArea({ latitude, longitude })).toBe(false);
  });

  it("refuses non-numbers", () => {
    expect(isInServiceArea({ latitude: NaN, longitude: -0.187 })).toBe(false);
  });

  it("is a closed ring of [lat, lng] points around Legon", () => {
    expect(SERVICE_AREA_POLYGON.length).toBeGreaterThan(10);
    for (const [lat, lng] of SERVICE_AREA_POLYGON) {
      expect(lat).toBeGreaterThan(5.6);
      expect(lat).toBeLessThan(5.7);
      expect(lng).toBeGreaterThan(-0.21);
      expect(lng).toBeLessThan(-0.16);
    }
  });

  it("explains a refusal in plain words", () => {
    expect(outsideServiceAreaMessage("pickup")).toMatch(/^That pickup is outside the CampusRide area/);
    expect(outsideServiceAreaMessage("dropoff")).toMatch(/^That drop-off/);
  });
});

describe("zoneForPoint", () => {
  const zones = [
    { id: "a", latitude: 5.6533, longitude: -0.1874 },
    { id: "b", latitude: 5.6490, longitude: -0.1856 },
  ];
  it("gives the nearest zone inside the area, however far its centre is", () => {
    expect(zoneForPoint({ latitude: 5.6534, longitude: -0.1873 }, zones)?.id).toBe("a");
    expect(zoneForPoint({ latitude: 5.62218, longitude: -0.17326 }, zones)?.id).toBe("b");
  });
  it("gives none outside the area", () => {
    expect(zoneForPoint({ latitude: 6.6885, longitude: -1.6244 }, zones)).toBeNull();
  });
});
