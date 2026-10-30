/**
 * Cars near the rider on the Home map (like Bolt or Uber): approved drivers
 * who are online, have a free seat, are on campus and were heard from in the
 * last minute. Shared by the server (GET /rides/nearby-cars) and the rider
 * app.
 *
 * Privacy: a car is its position and heading only — never who drives it.
 * Its `key` lasts a few minutes (so the app can glide the same car between
 * updates) and then changes, so a car can't be followed for longer; the
 * position is moved by a fixed 10-25 m for the same few minutes, which keeps
 * the movement smooth while hiding exactly where the car is.
 */

export const NEARBY_CARS_PATH = "/rides/nearby-cars";

/** At most this many cars in one answer: the nearest to the point asked about. */
export const NEARBY_CARS_MAX = 20;

/** How often the Home map asks again while it is on screen. */
export const NEARBY_CARS_POLL_MS = 10_000;

/** A car the driver's app hasn't reported from for longer than this is left out. */
export const NEARBY_CAR_FRESH_MS = 60_000;

/** How long a car's key (and its position offset) lasts before it changes. */
export const NEARBY_CAR_KEY_MS = 5 * 60_000;

/** The position's offset, in metres: never less (always blurred), never more (still on its road). */
export const NEARBY_CAR_OFFSET_M = { min: 10, max: 25 } as const;

export interface NearbyCar {
  /** Short-lived (NEARBY_CAR_KEY_MS); says nothing about the driver. */
  key: string;
  latitude: number;
  longitude: number;
  /** Compass degrees (0 = north) the car is facing; null until it has moved. */
  heading: number | null;
}

export interface NearbyCarsResponse {
  cars: NearbyCar[];
}
