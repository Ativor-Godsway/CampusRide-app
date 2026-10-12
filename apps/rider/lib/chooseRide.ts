import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Location from "expo-location";
import type { CampusPlace, TripEnd, Zone } from "@rida/shared";
import { gpsEnd, tripEndParams } from "@rida/shared";
import { getPlaces, getZones, placesQueryKey } from "@rida/mobile-shared";

/** Where Choose a ride was opened from, so its "Edit" knows how to go back. */
export type ChooseRideOrigin = "plan" | "home";

/** Route params for /ride/type (Choose a ride): both ends as exact points. */
export function chooseRideParams(pickup: TripEnd, dropoff: TripEnd, from: ChooseRideOrigin) {
  return { ...tripEndParams("pickup", pickup), ...tripEndParams("dropoff", dropoff), from };
}

/** The campus zone list (still used to draw rides booked before exact pins). */
export function useZones() {
  return useQuery<Zone[]>({ queryKey: ["zones"], queryFn: getZones, staleTime: 10 * 60_000 });
}

/** Every campus place, fetched once an hour: search and pin labels run on the phone. */
export function usePlaces() {
  return useQuery<CampusPlace[]>({ queryKey: placesQueryKey, queryFn: getPlaces, staleTime: 60 * 60_000 });
}

const FIX_TIMEOUT_MS = 8000;
/** A last-known fix this recent is good enough for a pickup. */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;

async function currentCoords(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;

    // The last known fix is near-instant; a fresh one can take seconds.
    const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
    if (last) return last.coords;

    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FIX_TIMEOUT_MS)),
    ]);
    return fresh?.coords ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the rider's CURRENT pickup: their exact position as "Current
 * location" (with the place they're at, if any). Null when location is
 * off/denied/unavailable, so callers fall back to asking. Never throws.
 * Whether it is inside the service area is the caller's check (tripEndProblem).
 */
export function useResolvePickup() {
  const queryClient = useQueryClient();
  return useCallback(async (): Promise<TripEnd | null> => {
    const [coords, places] = await Promise.all([
      currentCoords(),
      queryClient
        .fetchQuery<CampusPlace[]>({ queryKey: placesQueryKey, queryFn: getPlaces, staleTime: 60 * 60_000 })
        .catch(() => [] as CampusPlace[]),
    ]);
    if (!coords) return null;
    const { atPlaceName: _at, ...end } = gpsEnd({ latitude: coords.latitude, longitude: coords.longitude }, places);
    return end;
  }, [queryClient]);
}
