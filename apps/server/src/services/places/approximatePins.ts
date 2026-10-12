/**
 * Where to SHOW a rider's stops to a driver who hasn't been given that rider
 * yet (the add-rider preview): the named place the pin is at or near, never
 * the pin itself.
 *
 * A pin chosen from a place is that place (or within MAX_PIN_ADJUST_METERS
 * of it), so this is usually almost exact; a dropped or GPS pin shows at the
 * nearest place within NEAR_PLACE_METERS, else at its zone centre. Once the
 * rider is in the car, the driver gets the real pin.
 */
import { NEAR_PLACE_METERS, nearestPlace, type RidePinFields } from "@rida/shared";

type Point = { latitude: number; longitude: number };

function approximate(
  lat: number | null,
  lng: number | null,
  placeId: string | null,
  zone: Point | undefined,
  places: readonly (Point & { id: string })[],
): Point | null {
  if (lat == null || lng == null) return null; // no pin: the zone centre, as before
  const chosen = placeId ? places.find((p) => p.id === placeId) : undefined;
  if (chosen) return { latitude: chosen.latitude, longitude: chosen.longitude };
  const near = nearestPlace({ latitude: lat, longitude: lng }, places);
  if (near && near.meters <= NEAR_PLACE_METERS) return { latitude: near.place.latitude, longitude: near.place.longitude };
  return zone ? { latitude: zone.latitude, longitude: zone.longitude } : null;
}

export function approximatePins(
  ride: Pick<RidePinFields, "pickupLat" | "pickupLng" | "pickupPlaceId" | "pickupLabel" | "dropoffLat" | "dropoffLng" | "dropoffPlaceId" | "dropoffLabel"> & {
    pickupZoneId: string;
    dropoffZoneId: string;
  },
  zones: ReadonlyMap<string, Point>,
  places: readonly (Point & { id: string })[],
): Pick<RidePinFields, "pickupLat" | "pickupLng" | "pickupLabel" | "dropoffLat" | "dropoffLng" | "dropoffLabel"> {
  const pickup = approximate(ride.pickupLat, ride.pickupLng, ride.pickupPlaceId, zones.get(ride.pickupZoneId), places);
  const dropoff = approximate(ride.dropoffLat, ride.dropoffLng, ride.dropoffPlaceId, zones.get(ride.dropoffZoneId), places);
  return {
    pickupLat: pickup?.latitude ?? null,
    pickupLng: pickup?.longitude ?? null,
    pickupLabel: ride.pickupLabel,
    dropoffLat: dropoff?.latitude ?? null,
    dropoffLng: dropoff?.longitude ?? null,
    dropoffLabel: ride.dropoffLabel,
  };
}
