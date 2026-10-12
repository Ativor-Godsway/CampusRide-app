/**
 * Who may see a ride's exact pins.
 *
 * A pin is where a person will be standing, so it goes only to that rider,
 * their assigned driver and admins. Everyone else gets the place name at
 * most: the driver's request list and broadcast before accepting
 * (requestPlaceNames), other riders sharing the car (hideOtherRidersPins),
 * and never the public /track page.
 *
 * Fields are blanked to null rather than removed, so every response keeps
 * one shape and an app can't tell "hidden" from "booked without a pin".
 */
import { RIDE_PIN_FIELDS, stopLabel, type RidePinFields } from "@rida/shared";

type WithPins = Partial<RidePinFields>;

const NO_PINS: RidePinFields = {
  pickupLat: null,
  pickupLng: null,
  pickupLabel: null,
  pickupPlaceId: null,
  dropoffLat: null,
  dropoffLng: null,
  dropoffLabel: null,
  dropoffPlaceId: null,
  pickupNote: null,
};

/** The same object with every pin field null. */
export function withoutPins<T extends WithPins>(row: T): T {
  return { ...row, ...NO_PINS };
}

/** Just the pin fields of a row (null where absent), for building a response. */
export function pinFieldsOf(row: WithPins | null | undefined): RidePinFields {
  const out = { ...NO_PINS };
  if (!row) return out;
  for (const field of RIDE_PIN_FIELDS) {
    const value = row[field];
    if (value !== undefined) (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

/**
 * A ride as one of its riders may see it. The ride-level pins belong to the
 * ride's owner (riderId); in a shared car another rider sees only their own
 * seat's pins.
 */
export function hideOtherRidersPins<
  R extends WithPins & { riderId: string; passengers?: ReadonlyArray<WithPins & { riderId: string }> },
>(ride: R, viewerId: string): R {
  const own = ride.riderId === viewerId ? ride : withoutPins(ride);
  if (!ride.passengers) return own;
  return {
    ...own,
    passengers: ride.passengers.map((p) => (p.riderId === viewerId ? p : withoutPins(p))),
  };
}

/**
 * Names, never coordinates: what a driver who hasn't accepted a request is
 * told about where it goes ("Balme Library", or the zone name for a request
 * booked without a pin).
 */
export function requestPlaceNames(
  ride: Pick<RidePinFields, "pickupLabel" | "dropoffLabel">,
  pickupZoneName: string,
  dropoffZoneName: string,
): { pickupPlaceName: string; dropoffPlaceName: string } {
  return {
    pickupPlaceName: stopLabel(ride.pickupLabel, pickupZoneName),
    dropoffPlaceName: stopLabel(ride.dropoffLabel, dropoffZoneName),
  };
}
