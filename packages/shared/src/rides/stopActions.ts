/**
 * Acting on any stop of a trip, in any order: the driver reaches Bill before
 * Ali, so Bill's pickup must be markable from the Stops list without doing
 * Ali's first. The rules shared by the driver app and the server, pure so
 * they are tested once here.
 */
import { haversineDistanceMeters } from "../geo/distance";
import type { PassengerStatus } from "../types/ride";
import { riderName, type TripStop } from "./tripStops";

/** Further than this from a rider's stop, marking it asks "Mark anyway?" (never blocks). */
export const STOP_FAR_WARNING_METERS = 300;

/** How long "Undo" stays on screen after a pickup or drop-off. */
export const UNDO_WINDOW_MS = 10_000;

/**
 * How long after the step reached it the server still takes an undo: the
 * window plus time for the undo itself to travel (it is sent after the step
 * was answered, so the server's clock starts later than the phone's).
 */
export const UNDO_ACCEPTED_FOR_MS = UNDO_WINDOW_MS + 5_000;

/** The steps that can be undone. */
export type UndoableStep = "pickup" | "dropoff";

/**
 * What a stop in the Stops list can be marked as now, or null: every open
 * pickup can be marked picked up (WAITING or ARRIVED), a drop-off only once
 * that rider is on board.
 */
export function stopMarkAction(stop: Pick<TripStop, "kind" | "passengerStatus">): UndoableStep | null {
  if (stop.kind === "PICKUP") {
    return stop.passengerStatus === "WAITING" || stop.passengerStatus === "ARRIVED" ? "pickup" : null;
  }
  return stop.passengerStatus === "PICKED_UP" ? "dropoff" : null;
}

/** True only when the position is known and further than `meters` from the stop. */
export function isFarFromStop(
  position: { latitude: number; longitude: number } | null | undefined,
  point: { latitude: number; longitude: number },
  meters = STOP_FAR_WARNING_METERS,
): boolean {
  return !!position && haversineDistanceMeters(position, point) > meters;
}

export interface MarkStopPrompt {
  title: string;
  /** Only when the driver is far from the stop. */
  message: string | undefined;
  confirmLabel: string;
  far: boolean;
}

/**
 * The confirm pop-up before marking a stop: "Mark Bill as picked up?", with
 * "You're far from Bill's pickup. Mark anyway?" when the driver's position
 * is more than STOP_FAR_WARNING_METERS away. Without a position, no warning.
 */
export function markStopPrompt(
  stop: Pick<TripStop, "kind" | "riderFirstName" | "point">,
  position: { latitude: number; longitude: number } | null | undefined,
): MarkStopPrompt {
  const name = riderName(stop);
  const pickup = stop.kind === "PICKUP";
  const far = isFarFromStop(position, stop.point);
  return {
    title: `Mark ${name} as ${pickup ? "picked up" : "dropped off"}?`,
    message: far ? `You're far from ${name}'s ${pickup ? "pickup" : "drop-off"}. Mark anyway?` : undefined,
    confirmLabel: far ? "Mark anyway" : pickup ? "Picked up" : "Dropped off",
    far,
  };
}

/**
 * Where an undone step puts the seat back: a pickup goes back to ARRIVED, or
 * to WAITING when the arrival was sent with it (marked straight from
 * WAITING); a drop-off goes back to PICKED_UP.
 */
export function undoneStatus(step: UndoableStep, withArrival = false): PassengerStatus {
  if (step === "dropoff") return "PICKED_UP";
  return withArrival ? "WAITING" : "ARRIVED";
}
