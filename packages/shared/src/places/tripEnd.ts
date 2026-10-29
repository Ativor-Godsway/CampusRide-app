/**
 * One end of a trip as the rider app holds it while planning: a campus
 * place, the rider's live GPS position, or a pin dropped on the map — always
 * with an exact point. Pure, so the planning rules (labels, the "move pin"
 * limit, recent destinations, route params) are tested once here.
 */
import { haversineDistanceMeters } from "../geo/distance";
import { isInServiceArea } from "../geo/serviceArea";
import { MAX_PIN_ADJUST_METERS, type RidePinFields } from "../rides/ridePins";
import {
  AT_PLACE_METERS,
  NEAR_PLACE_METERS,
  labelForPoint,
  nearestPlace,
  type CampusPlace,
} from "./campusPlaces";

export type TripEndKind = "place" | "gps" | "pin";

export interface TripEnd {
  kind: TripEndKind;
  latitude: number;
  longitude: number;
  /** What the rider sees: "Balme Library", "Current location", "Near Volta Hall". */
  label: string;
  /** The campus place chosen (or the one a GPS fix is at), when there is one. */
  placeId: string | null;
}

/** What "Current location" is shown as. */
export const CURRENT_LOCATION_LABEL = "Current location";

export function placeEnd(place: Pick<CampusPlace, "id" | "name" | "latitude" | "longitude">): TripEnd {
  return { kind: "place", latitude: place.latitude, longitude: place.longitude, label: place.name, placeId: place.id };
}

/** A pin dropped on the map: labelled by the nearest place ("Near Night Market"). */
export function pinEnd(
  point: { latitude: number; longitude: number },
  places: readonly Pick<CampusPlace, "name" | "latitude" | "longitude">[],
): TripEnd {
  return { kind: "pin", ...point, label: labelForPoint(point, places), placeId: null };
}

/**
 * The rider's live position as a pickup: "Current location", plus the place
 * they're at when one is within AT_PLACE_METERS (shown as "At Balme Library").
 */
export function gpsEnd(
  point: { latitude: number; longitude: number },
  places: readonly Pick<CampusPlace, "id" | "name" | "latitude" | "longitude">[],
): TripEnd & { atPlaceName: string | null } {
  const near = nearestPlace(point, places);
  const at = near && near.meters <= AT_PLACE_METERS ? near.place : null;
  return {
    kind: "gps",
    latitude: point.latitude,
    longitude: point.longitude,
    label: CURRENT_LOCATION_LABEL,
    placeId: at?.id ?? null,
    atPlaceName: at?.name ?? null,
  };
}

/** The second line under a pickup that is the rider's own position. */
export function gpsSubtitle(end: TripEnd, places: readonly Pick<CampusPlace, "id" | "name">[]): string | null {
  if (end.kind !== "gps" || !end.placeId) return null;
  const place = places.find((p) => p.id === end.placeId);
  return place ? `At ${place.name}` : null;
}

/**
 * Where a pickup is, for sentences ("Asking drivers near Akuafo Hall",
 * "Meet at Akuafo Hall"): a real place name, never "Current location" or
 * "Pinned location". The place chosen (or the one a GPS fix is at), else the
 * nearest within NEAR_PLACE_METERS, else the ride's zone. `at` is false when
 * the point is only near the place. Null when there is no name to give.
 */
export function pickupPlace(
  end: TripEnd,
  places: readonly Pick<CampusPlace, "id" | "name" | "latitude" | "longitude">[],
  zoneName?: string | null,
): { name: string; at: boolean } | null {
  const chosen = end.placeId ? places.find((p) => p.id === end.placeId) : undefined;
  if (chosen) return { name: chosen.name, at: true };
  if (end.kind === "place") return { name: end.label, at: true };
  const near = nearestPlace(end, places);
  if (near && near.meters <= NEAR_PLACE_METERS) {
    return { name: near.place.name, at: near.meters <= AT_PLACE_METERS };
  }
  const zone = zoneName?.trim();
  return zone ? { name: zone, at: false } : null;
}

export function isSameSpot(a: TripEnd | null, b: TripEnd | null, meters = 100): boolean {
  return Boolean(a && b && haversineDistanceMeters(a, b) < meters);
}

/** Why an end can't be used, in words; null when it can. */
export function tripEndProblem(end: TripEnd, which: "pickup" | "dropoff"): string | null {
  if (isInServiceArea(end)) return null;
  return which === "pickup"
    ? "Your pickup is outside campus. CampusRide only works on the University of Ghana (Legon) campus."
    : "That drop-off is outside campus. CampusRide only works on the University of Ghana (Legon) campus.";
}

// ─── "Move pin to the exact spot" ────────────────────────────────────────────

/**
 * Where a dragged pickup pin lands: where it was dropped, unless that is more
 * than `maxMeters` from where it started — then on the circle of that radius,
 * in the direction it was dragged. `clamped` says the rider went too far.
 */
export function clampToRadius(
  origin: { latitude: number; longitude: number },
  dropped: { latitude: number; longitude: number },
  maxMeters = MAX_PIN_ADJUST_METERS,
): { latitude: number; longitude: number; clamped: boolean } {
  const d = haversineDistanceMeters(origin, dropped);
  if (d <= maxMeters) return { latitude: dropped.latitude, longitude: dropped.longitude, clamped: false };
  const f = maxMeters / d;
  return {
    latitude: origin.latitude + (dropped.latitude - origin.latitude) * f,
    longitude: origin.longitude + (dropped.longitude - origin.longitude) * f,
    clamped: true,
  };
}

/**
 * The pickup after the rider moved its pin: the same place (and name) while
 * it stays within MAX_PIN_ADJUST_METERS of a chosen place — as the server
 * decides it — otherwise a pin labelled by the nearest place. A GPS pickup
 * stays "Current location" for small nudges.
 */
export function movedEnd(
  original: TripEnd,
  point: { latitude: number; longitude: number },
  places: readonly Pick<CampusPlace, "id" | "name" | "latitude" | "longitude">[],
): TripEnd {
  if (original.kind === "place") {
    const place = places.find((p) => p.id === original.placeId);
    if (place && haversineDistanceMeters(place, point) <= MAX_PIN_ADJUST_METERS) return { ...original, ...point };
  }
  return pinEnd(point, places);
}

// ─── To the server, and through route params ─────────────────────────────────

/** The body of one end in POST /rides: the point, plus the place when one was chosen. */
export function tripEndBody(end: TripEnd): { latitude: number; longitude: number; placeId?: string } {
  return {
    latitude: end.latitude,
    longitude: end.longitude,
    ...(end.kind === "place" && end.placeId ? { placeId: end.placeId } : {}),
  };
}

/** Route params (strings) for one end, prefixed "pickup" or "dropoff". */
export function tripEndParams(prefix: "pickup" | "dropoff", end: TripEnd): Record<string, string> {
  return {
    [`${prefix}Kind`]: end.kind,
    [`${prefix}Lat`]: String(end.latitude),
    [`${prefix}Lng`]: String(end.longitude),
    [`${prefix}Label`]: end.label,
    [`${prefix}PlaceId`]: end.placeId ?? "",
  };
}

/** Reads tripEndParams back; null when the params don't describe a usable end. */
export function tripEndFromParams(
  prefix: "pickup" | "dropoff",
  params: Record<string, string | string[] | undefined>,
): TripEnd | null {
  const get = (k: string) => {
    const v = params[`${prefix}${k}`];
    return Array.isArray(v) ? v[0] : v;
  };
  const latitude = Number(get("Lat"));
  const longitude = Number(get("Lng"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || get("Lat") === undefined) return null;
  const kind = get("Kind");
  return {
    kind: kind === "place" || kind === "gps" || kind === "pin" ? kind : "pin",
    latitude,
    longitude,
    label: get("Label") || "Pinned location",
    placeId: get("PlaceId") || null,
  };
}

// ─── From a ride ─────────────────────────────────────────────────────────────

interface ZoneLike {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * A ride's end as a TripEnd: its exact pin when it has one, else the zone
 * centre (a ride booked by an app without pins), named after the zone.
 */
export function rideEnd(
  ride: Partial<RidePinFields>,
  which: "pickup" | "dropoff",
  zone: ZoneLike,
): TripEnd {
  const lat = which === "pickup" ? ride.pickupLat : ride.dropoffLat;
  const lng = which === "pickup" ? ride.pickupLng : ride.dropoffLng;
  const label = which === "pickup" ? ride.pickupLabel : ride.dropoffLabel;
  const placeId = (which === "pickup" ? ride.pickupPlaceId : ride.dropoffPlaceId) ?? null;
  if (lat != null && lng != null) {
    return { kind: placeId ? "place" : "pin", latitude: lat, longitude: lng, label: label?.trim() || zone.name, placeId };
  }
  return { kind: "pin", latitude: zone.latitude, longitude: zone.longitude, label: zone.name, placeId: null };
}

/**
 * The rider's recent destinations, newest first, each once: the same place
 * twice is one row, and so is the same pin (within ~30 m). Rides booked
 * without pins come back as their zone. `places` refreshes a place's name
 * and drops places that no longer exist.
 */
export function recentTripEnds(
  rides: readonly ({ createdAt: string | Date; dropoffZone: ZoneLike } & Partial<RidePinFields>)[],
  places: readonly Pick<CampusPlace, "id" | "name" | "latitude" | "longitude">[] | null,
  limit = 3,
): TripEnd[] {
  const sorted = [...rides].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const out: TripEnd[] = [];
  const byId = places ? new Map(places.map((p) => [p.id, p])) : null;
  for (const ride of sorted) {
    if (!ride.dropoffZone) continue;
    let end = rideEnd(ride, "dropoff", ride.dropoffZone);
    if (end.kind === "place" && end.placeId && byId) {
      const place = byId.get(end.placeId);
      // A place since removed is still a fine pin; a renamed one shows its new name.
      end = place ? placeEnd(place) : { ...end, kind: "pin", placeId: null };
    }
    const dup = out.some((o) =>
      o.placeId && end.placeId ? o.placeId === end.placeId : haversineDistanceMeters(o, end) < 30,
    );
    if (dup) continue;
    out.push(end);
    if (out.length === limit) break;
  }
  return out;
}

// ─── What Plan your ride lists ───────────────────────────────────────────────

/** Shown under "Popular on campus" before the rider types (matched by name; missing ones are skipped). */
export const POPULAR_PLACE_NAMES = [
  "Balme Library",
  "Night Market",
  "Main Gate (inside)",
  "University of Ghana Business School",
  "Central Cafeteria",
  "University of Ghana Sports Stadium",
] as const;
