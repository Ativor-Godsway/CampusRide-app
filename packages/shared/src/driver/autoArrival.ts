/**
 * Automatic arrival at a pickup (Stage 3 rule 3): the driver is "here" when
 * their live GPS STAYS within AUTO_ARRIVAL_RADIUS_METERS of the pickup zone,
 * moving slowly, for AUTO_ARRIVAL_DWELL_MS — not the moment they pass
 * through it. Driving past a pickup on the way somewhere else must never
 * tell a rider "your driver is here".
 *
 * Pure: feed it one GPS sample at a time with the state it returned last.
 */
import { haversineDistanceMeters } from "../geo/distance";

export const AUTO_ARRIVAL_RADIUS_METERS = 60;
/** Faster than this (~9 km/h) is driving, not arriving. */
export const AUTO_ARRIVAL_MAX_SPEED_MPS = 2.5;
export const AUTO_ARRIVAL_DWELL_MS = 10_000;

export interface ArrivalSample {
  latitude: number;
  longitude: number;
  /** Device speed in m/s when it reports one (it often doesn't, or reports -1). */
  speed?: number | null;
  /** When the fix was taken, ms. */
  at: number;
}

export interface ArrivalState {
  /** When the driver entered the zone slowly and stayed there, or null. */
  slowInsideSince: number | null;
  last: ArrivalSample | null;
}

export const INITIAL_ARRIVAL_STATE: ArrivalState = { slowInsideSince: null, last: null };

/** The sample's speed: the device's, or worked out from the previous sample. */
export function sampleSpeed(sample: ArrivalSample, last: ArrivalSample | null): number | null {
  if (typeof sample.speed === "number" && Number.isFinite(sample.speed) && sample.speed >= 0) return sample.speed;
  if (!last || sample.at <= last.at) return null;
  return haversineDistanceMeters(last, sample) / ((sample.at - last.at) / 1000);
}

export function stepArrival(
  state: ArrivalState,
  sample: ArrivalSample,
  pickup: { latitude: number; longitude: number },
): { state: ArrivalState; arrived: boolean } {
  const inside = haversineDistanceMeters(sample, pickup) <= AUTO_ARRIVAL_RADIUS_METERS;
  const speed = sampleSpeed(sample, state.last);
  // Unknown speed counts as slow: staying inside for the whole dwell is the real test.
  const slow = speed === null || speed <= AUTO_ARRIVAL_MAX_SPEED_MPS;
  const slowInsideSince = inside && slow ? (state.slowInsideSince ?? sample.at) : null;
  return {
    state: { slowInsideSince, last: sample },
    arrived: slowInsideSince !== null && sample.at - slowInsideSince >= AUTO_ARRIVAL_DWELL_MS,
  };
}
