/**
 * The campus gates riders know. Drivers never pass a gate: a gate is only a
 * place to be picked up or dropped off, on its INSIDE, at the nearest point
 * of a drivable campus road (where a car can stop and turn). The service
 * area (geo/serviceArea.ts) stops just inside the gates with `areaEndsHere`
 * (scripts/map/service-area.mjs cuts their approach roads).
 *
 * Each gate is a Place row keyed by `source` (seeded from
 * prisma/data/campus-places.csv; moved into place in an existing database by
 * the server's `places:campus` script). Positions are from OpenStreetMap and
 * the owner's pins of 2026-10-29: the barriers are OSM nodes, the inside
 * points sit on the road just behind them.
 */
import type { LatLng } from "../driver/requestsNearYou";

export interface CampusGateBarrier extends LatLng {
  /** The OSM node of the barrier (a lift or swing gate). */
  osmNode: number;
}

export interface CampusGate {
  /** The Place's `source`: stable across renames, so a place keeps its id and history. */
  source: string;
  name: string;
  aliases: readonly string[];
  /** Where a car stops: on a campus road just inside the gate. */
  inside: LatLng;
  /** The gate itself. The service area stops short of these. */
  barriers: readonly CampusGateBarrier[];
  /** Whether cars may drive through (none may in CampusRide; this records the gate's own status). */
  openToCars: boolean;
  /**
   * The service area stops just inside this gate (its approach from the
   * Avenue is cut). False for the TF gate: in OpenStreetMap, TF Hall is
   * behind it, and stays served until the owner decides otherwise.
   */
  areaEndsHere: boolean;
  /** Shown with the place wherever riders choose it. */
  note?: string;
}

export const CAMPUS_GATES: readonly CampusGate[] = [
  {
    source: "manual:main-gate",
    name: "Main Gate (inside)",
    aliases: ["Main Gate", "Legon Main Gate", "Main Entrance"],
    // On La Road, just south of Mekki Abass Circle, ~35 m behind the gate.
    inside: { latitude: 5.6503, longitude: -0.18139 },
    barriers: [
      { osmNode: 5813545126, latitude: 5.650495, longitude: -0.181131 },
      { osmNode: 5813545127, latitude: 5.650782, longitude: -0.18114 },
    ],
    openToCars: false,
    areaEndsHere: true,
    note: "Cars can't pass the main gate",
  },
  {
    // The place was "Okponglo Gate" (at the bus stop on J.J. Rawlings Avenue):
    // same gate, now named for the stadium and moved inside.
    source: "manual:okponglo-gate",
    name: "Stadium Gate",
    aliases: ["Okponglo Gate", "Okponglo Second Gate", "Second Gate", "Legon-Okponglo Security Post", "Sports Stadium Gate"],
    // On Jubilee Drive, ~35 m west of the lift gate at the security post.
    inside: { latitude: 5.640669, longitude: -0.18105 },
    barriers: [
      { osmNode: 10649363065, latitude: 5.640652, longitude: -0.180744 },
      { osmNode: 1269621500, latitude: 5.640572, longitude: -0.179699 },
    ],
    openToCars: true,
    areaEndsHere: true,
  },
  {
    source: "manual:tf-gate",
    name: "TF Gate",
    aliases: ["TF Hostel Gate", "TF Hall Gate"],
    // On the road south of the gate, where its one-way lanes meet.
    inside: { latitude: 5.66485, longitude: -0.18256 },
    barriers: [
      { osmNode: 5020636345, latitude: 5.665428, longitude: -0.182549 },
      { osmNode: 5713101589, latitude: 5.665432, longitude: -0.182626 },
    ],
    openToCars: true,
    areaEndsHere: false,
  },
];

/** The note to show with a place, from its `source` (null when it has none). */
export function placeNote(source: string | null | undefined): string | null {
  if (!source) return null;
  return CAMPUS_GATES.find((g) => g.source === source)?.note ?? null;
}
