import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  NEARBY_CARS_PATH,
  NEARBY_CARS_POLL_MS,
  asArray,
  type LatLng,
  type NearbyCar,
} from "@rida/shared";
import { api } from "../auth/apiClient";

/**
 * The cars on the rider's Home map (GET /rides/nearby-cars; rules in
 * @rida/shared rides/nearbyCars.ts). Anything malformed is left out, never
 * an error: no cars just means an empty map.
 */
export async function getNearbyCars(near: LatLng | null): Promise<NearbyCar[]> {
  const res = await api.get<{ cars?: unknown }>(NEARBY_CARS_PATH, {
    params: near ? { latitude: near.latitude, longitude: near.longitude } : undefined,
  });
  return asArray(res.data?.cars).filter(
    (c): c is NearbyCar =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as NearbyCar).key === "string" &&
      Number.isFinite((c as NearbyCar).latitude) &&
      Number.isFinite((c as NearbyCar).longitude) &&
      ((c as NearbyCar).heading === null || Number.isFinite((c as NearbyCar).heading)),
  );
}

/**
 * Asks for the cars every NEARBY_CARS_POLL_MS while `enabled` (the caller:
 * a rider with no ride going on), the screen is on show and the app is in
 * the foreground; never otherwise. A failed ask (offline, rate-limited)
 * keeps the cars shown; turning off clears them, so a car seen long ago
 * doesn't glide across the map when the rider comes back.
 */
export function useNearbyCars(enabled: boolean, near: LatLng | null): NearbyCar[] {
  const [cars, setCars] = useState<NearbyCar[]>([]);
  const nearRef = useRef(near);
  nearRef.current = near;

  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  // Anything but "background": the first state can be "unknown" on iOS, and
  // "inactive" (Control Centre pulled down) still shows the map.
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setForeground(state !== "background"));
    return () => sub.remove();
  }, []);

  const on = enabled && focused && foreground;
  useEffect(() => {
    if (!on) {
      setCars([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      void getNearbyCars(nearRef.current).then(
        (next) => {
          if (!cancelled) setCars(next);
        },
        () => {},
      );
    load();
    const timer = setInterval(load, NEARBY_CARS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [on]);

  return cars;
}
