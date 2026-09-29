import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Location from "expo-location";
import type { Zone } from "@rida/shared";
import { nearestZone } from "@rida/shared";
import { getZones } from "@rida/mobile-shared";

/** Where Choose a ride was opened from, so its "Edit" knows how to go back. */
export type ChooseRideOrigin = "plan" | "home";

/** Route params for /ride/type (Choose a ride) for a pickup → drop-off pair. */
export function chooseRideParams(pickup: Zone, dropoff: Zone, from: ChooseRideOrigin) {
  return {
    pickupZoneId: pickup.id,
    dropoffZoneId: dropoff.id,
    pickupZoneName: pickup.name,
    dropoffZoneName: dropoff.name,
    pickupLat: String(pickup.latitude),
    pickupLng: String(pickup.longitude),
    dropoffLat: String(dropoff.latitude),
    dropoffLng: String(dropoff.longitude),
    from,
  };
}

/** The campus zone list, shared (one cache entry) by Home and Plan your ride. */
export function useZones() {
  return useQuery<Zone[]>({ queryKey: ["zones"], queryFn: getZones, staleTime: 10 * 60_000 });
}

const FIX_TIMEOUT_MS = 8000;
/** A last-known fix this recent is good enough to pick the nearest zone. */
const LAST_KNOWN_MAX_AGE_MS = 5 * 60_000;

async function currentCoords(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;

    // The last known fix is near-instant; a fresh one can take seconds.
    const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
    if (last) return last.coords;

    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FIX_TIMEOUT_MS)),
    ]);
    return fresh?.coords ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the rider's CURRENT pickup: the campus zone nearest to them.
 * Null when location is off/denied/unavailable, so callers fall back to
 * asking (Plan your ride). Never throws.
 */
export function useResolvePickup() {
  const queryClient = useQueryClient();
  return useCallback(async (): Promise<Zone | null> => {
    const [coords, zones] = await Promise.all([
      currentCoords(),
      queryClient
        .fetchQuery<Zone[]>({ queryKey: ["zones"], queryFn: getZones, staleTime: 10 * 60_000 })
        .catch(() => []),
    ]);
    if (!coords || zones.length === 0) return null;
    return nearestZone(coords.latitude, coords.longitude, zones);
  }, [queryClient]);
}
