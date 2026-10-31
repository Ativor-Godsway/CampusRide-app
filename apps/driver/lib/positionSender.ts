import { DRIVER_CLIENT_EVENTS, positionToSend, type ArrivalSample } from "@rida/shared";
import { getRideSocket } from "@rida/mobile-shared";
import { onDriverLocation } from "./backgroundLocation";

/**
 * Sends the driver's position to the server (rules: @rida/shared
 * driver/positionSharing): during a trip for the riders on it, online
 * without a trip for riders' Home maps and the online records.
 *
 * Every new fix is offered here, and positionToSend decides whether it goes
 * out now. Fixes from the background location task arrive straight from it
 * (onDriverLocation), so positions keep going while the app is in the
 * background or the screen is locked — Android pauses JS timers then, and
 * the timer-only sender this replaces stopped: riders lost the car on a trip
 * while the driver used a navigation app. TripRuntime also re-offers the
 * latest fix on a timer, for when no new fix comes (iPhone while parked).
 *
 * Volatile: a position that can't go now is dropped, not queued and sent
 * late as if it were current.
 */

let rideId: string | null = null;
let online = false;
let latest: ArrivalSample | null = null;
let lastSentAt: number | null = null;
let lastSentFor: string | null = null;

/** What is being shared: the trip under way (if any), and whether the driver is online. */
export function setPositionSharing(next: { rideId: string | null; online: boolean }): void {
  rideId = next.rideId;
  online = next.online;
}

/** A new fix (or the latest again): sent if one is due. */
export function offerPosition(sample: ArrivalSample | null = latest, now: number = Date.now()): void {
  if (sample) latest = sample;
  if (!latest) return;
  const send = positionToSend({ rideId, online, lastSentAt, lastSentFor }, now);
  if (!send) return;
  const socket = getRideSocket();
  if (send.kind === "trip") {
    socket.volatile.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: send.rideId, lat: latest.latitude, lng: latest.longitude });
  } else {
    socket.volatile.emit(DRIVER_CLIENT_EVENTS.POSITION_UPDATE, { lat: latest.latitude, lng: latest.longitude });
  }
  lastSentAt = now;
  lastSentFor = send.kind === "trip" ? send.rideId : "idle";
}

// Every background fix, as it arrives — the one path that works while Android pauses timers.
onDriverLocation((sample) => offerPosition(sample));
