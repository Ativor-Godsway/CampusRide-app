import { useSyncExternalStore } from "react";
import type { TripEnd } from "@rida/shared";

/**
 * Hand-off from "Choose on map" (/ride/pick) back to Plan your ride: the
 * picker puts the chosen pin here and goes back; Plan your ride takes it.
 * A tiny in-memory store rather than route params, because going back can't
 * carry params, and pushing Plan your ride again would stack it twice.
 */
export interface PickedPin {
  field: "pickup" | "dropoff";
  end: TripEnd;
}

let picked: PickedPin | null = null;
const listeners = new Set<() => void>();

export function setPickedPin(value: PickedPin | null): void {
  picked = value;
  for (const l of listeners) l();
}

/** The pin waiting to be taken; call setPickedPin(null) once used. */
export function usePickedPin(): PickedPin | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => picked,
  );
}
