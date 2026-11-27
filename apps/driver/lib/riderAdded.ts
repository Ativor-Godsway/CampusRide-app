import { useEffect, useState } from "react";
import { DRIVER_EVENTS, type RiderAddedPayload } from "@rida/shared";
import { getRideSocket } from "@rida/mobile-shared";
import { alertRiderAdded } from "./offerAlert";

/**
 * Auto-added riders (fill moving cars first, @rida/shared rides/movingCar.ts):
 * the server's driver:rider_added, kept here from app start (RiderAddedListener
 * in the root layout) so the trip screen shows the banner even if it opened a
 * moment later, while the 15 s Undo lasts. Each one sounds and buzzes once.
 */

let latest: RiderAddedPayload | null = null;
const listeners = new Set<(p: RiderAddedPayload | null) => void>();

function publish(p: RiderAddedPayload | null) {
  latest = p;
  for (const l of listeners) l(p);
}

/** Root layout: listens for the event for the life of the app. */
export function RiderAddedListener() {
  useEffect(() => {
    const socket = getRideSocket();
    const onAdded = (p: RiderAddedPayload) => {
      if (!p?.rideId || !p.passengerId) return;
      alertRiderAdded();
      publish(p);
    };
    socket.on(DRIVER_EVENTS.RIDER_ADDED, onAdded);
    return () => {
      socket.off(DRIVER_EVENTS.RIDER_ADDED, onAdded);
    };
  }, []);
  return null;
}

/** The auto-added rider on this trip whose Undo is still open (null otherwise), and a way to close the banner. */
export function useRiderAdded(rideId: string | undefined): { added: RiderAddedPayload | null; dismiss: () => void } {
  const [added, setAdded] = useState<RiderAddedPayload | null>(() => (latest && latest.rideId === rideId && latest.undoUntil > Date.now() ? latest : null));
  useEffect(() => {
    const on = (p: RiderAddedPayload | null) => setAdded(p && p.rideId === rideId ? p : null);
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, [rideId]);
  return { added, dismiss: () => publish(null) };
}

/** Tests only. */
export function publishRiderAddedForTests(p: RiderAddedPayload | null): void {
  publish(p);
}
