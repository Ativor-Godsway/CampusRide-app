/**
 * Turns what the app sends for one end of a trip — a campus place, an exact
 * pin, or both (a place whose pin the rider nudged) — into what the ride
 * stores: the pin, a label, and the zone.
 *
 * The zone is ALWAYS worked out here, as the nearest zone to the pin. The
 * app never chooses it: dispatch, fares and shared matching all key off the
 * zone, so it must come from the one place that can be trusted. The label is
 * worked out here too (it is shown to the driver), never taken from the app.
 */
import type { PrismaClient } from "@prisma/client";
import {
  MAX_PIN_ADJUST_METERS,
  haversineDistanceMeters,
  isInServiceArea,
  labelForPoint,
  nearestZone,
  outsideServiceAreaMessage,
} from "@rida/shared";
import { getActiveZones } from "../zones/zoneCache";
import { getActivePlaces } from "./placeCache";

export type RideEnd = "pickup" | "dropoff";

/** One end of a trip as the app sends it. At least one of the two is required. */
export interface RideEndInput {
  latitude?: number;
  longitude?: number;
  placeId?: string;
}

export interface ResolvedRideEnd {
  zoneId: string;
  latitude: number;
  longitude: number;
  label: string;
  placeId: string | null;
}

export class OutsideServiceAreaError extends Error {
  readonly code = "OUTSIDE_SERVICE_AREA";
  constructor(readonly end: RideEnd) {
    super(outsideServiceAreaMessage(end));
    this.name = "OutsideServiceAreaError";
  }
}

export class PlaceNotFoundError extends Error {
  readonly code = "PLACE_NOT_FOUND";
  constructor(readonly end: RideEnd) {
    super("That place isn't available any more. Search again or drop a pin.");
    this.name = "PlaceNotFoundError";
  }
}

/**
 * Reads `{ latitude, longitude, placeId }` from a request body. Returns null
 * when the value is absent, an error string when it is malformed.
 */
export function parseRideEndInput(raw: unknown, end: RideEnd): RideEndInput | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return { error: `${end} must be an object` };
  const { latitude, longitude, placeId } = raw as Record<string, unknown>;
  const hasPoint = latitude !== undefined || longitude !== undefined;
  if (hasPoint) {
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return { error: `${end}.latitude and ${end}.longitude must both be numbers` };
    }
  }
  if (placeId !== undefined && (typeof placeId !== "string" || placeId.length === 0)) {
    return { error: `${end}.placeId must be a non-empty string` };
  }
  if (!hasPoint && placeId === undefined) {
    return { error: `${end} needs a placeId or latitude and longitude` };
  }
  return {
    ...(hasPoint ? { latitude: latitude as number, longitude: longitude as number } : {}),
    ...(placeId !== undefined ? { placeId: placeId as string } : {}),
  };
}

export async function resolveRideEnd(
  prisma: PrismaClient,
  end: RideEnd,
  input: RideEndInput,
): Promise<ResolvedRideEnd> {
  const [places, zones] = await Promise.all([getActivePlaces(prisma), getActiveZones(prisma)]);

  const place = input.placeId ? places.find((p) => p.id === input.placeId) : undefined;
  if (input.placeId && !place) throw new PlaceNotFoundError(end);

  const point =
    input.latitude !== undefined && input.longitude !== undefined
      ? { latitude: input.latitude, longitude: input.longitude }
      : { latitude: place!.latitude, longitude: place!.longitude };

  if (!isInServiceArea(point)) throw new OutsideServiceAreaError(end);

  // Only zones in service: a pin is never derived to a retired zone.
  const zone = nearestZone(point.latitude, point.longitude, zones);
  // No zones at all is a broken install, not a rider error.
  if (!zone) throw new Error("No zones: seed the zones before booking rides");

  // A place the rider chose keeps its name while the pin stays near it
  // ("Move pin to the exact spot"); dragged further, it's just a pin.
  const keepsPlace = place && haversineDistanceMeters(point, place) <= MAX_PIN_ADJUST_METERS;
  return {
    zoneId: zone.id,
    latitude: point.latitude,
    longitude: point.longitude,
    label: keepsPlace ? place.name : labelForPoint(point, places),
    placeId: keepsPlace ? place.id : null,
  };
}
