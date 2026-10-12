/**
 * Exact pickup and drop-off pins on a ride (or on one rider's seat in a
 * shared car). Every ride still has a pickup and drop-off ZONE — the nearest
 * zone to the pin — for dispatch, fares and shared matching; the pin is where
 * the car actually goes. A ride booked from an app build without pins has
 * none, and everything falls back to the zone centre, exactly as before.
 */

/** The pin columns, as the API returns them (all null for an old-style ride). */
export interface RidePinFields {
  pickupLat: number | null;
  pickupLng: number | null;
  pickupLabel: string | null;
  pickupPlaceId: string | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  dropoffLabel: string | null;
  dropoffPlaceId: string | null;
  pickupNote: string | null;
}

export const RIDE_PIN_FIELDS = [
  "pickupLat",
  "pickupLng",
  "pickupLabel",
  "pickupPlaceId",
  "dropoffLat",
  "dropoffLng",
  "dropoffLabel",
  "dropoffPlaceId",
  "pickupNote",
] as const satisfies readonly (keyof RidePinFields)[];

/** The fields that say WHERE someone is: never sent to anyone but the rider, their driver and admins. */
export const RIDE_PIN_COORDINATE_FIELDS = [
  "pickupLat",
  "pickupLng",
  "dropoffLat",
  "dropoffLng",
] as const satisfies readonly (keyof RidePinFields)[];

/** "At the main gate, blue shirt" — the most a pickup note may hold. */
export const PICKUP_NOTE_MAX_LENGTH = 140;

/** How far "Move pin to the exact spot" may drag a pickup from where it started. */
export const MAX_PIN_ADJUST_METERS = 200;

/** A pickup and drop-off closer than this are the same place: the trip is refused. */
export const MIN_TRIP_METERS = 100;

/** Within this of an exact pin the driver is "at" the stop (zone centres keep AT_STOP_RADIUS_METERS). */
export const PIN_ARRIVAL_RADIUS_METERS = 50;

type Point = { latitude: number; longitude: number };

/** The pickup pin, or null when the ride has none. */
export function pickupPin(fields: Partial<Pick<RidePinFields, "pickupLat" | "pickupLng">>): Point | null {
  return fields.pickupLat != null && fields.pickupLng != null
    ? { latitude: fields.pickupLat, longitude: fields.pickupLng }
    : null;
}

/** The drop-off pin, or null when the ride has none. */
export function dropoffPin(fields: Partial<Pick<RidePinFields, "dropoffLat" | "dropoffLng">>): Point | null {
  return fields.dropoffLat != null && fields.dropoffLng != null
    ? { latitude: fields.dropoffLat, longitude: fields.dropoffLng }
    : null;
}

/** Where the car goes: the exact pin, or the zone centre for a ride without one. */
export function stopPoint(pin: Point | null, zone: Point): Point {
  return pin ?? { latitude: zone.latitude, longitude: zone.longitude };
}

/** What to call a stop: the pin's label, or the zone name for a ride without one. */
export function stopLabel(label: string | null | undefined, zoneName: string): string {
  return label?.trim() ? label : zoneName;
}

/** Trims a note; empty becomes null. Returns an error string when it is too long or not text. */
export function parsePickupNote(raw: unknown): { ok: true; note: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false, error: "pickupNote must be text" };
  const note = raw.replace(/\s+/g, " ").trim();
  if (note.length > PICKUP_NOTE_MAX_LENGTH) {
    return { ok: false, error: `Keep the note for your driver to ${PICKUP_NOTE_MAX_LENGTH} characters.` };
  }
  return { ok: true, note: note || null };
}
