import { useCallback, useState } from "react";
import * as Location from "expo-location";

export type LocationStatus = "idle" | "loading" | "granted" | "denied" | "error";

export interface CurrentLocationState {
  status: LocationStatus;
  coords: { latitude: number; longitude: number } | null;
  /** Requests foreground permission (if needed) and fetches a GPS fix. */
  requestLocation: () => Promise<{ latitude: number; longitude: number } | null>;
}

/**
 * Wraps Expo Location's permission + current-position flow. Never throws —
 * permission denial or a location error resolves to `null` and sets
 * `status` to "denied"/"error" so callers can fall back to the zone list.
 */
export function useCurrentLocation(): CurrentLocationState {
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);

  const requestLocation = useCallback(async () => {
    setStatus("loading");

    try {
      const { status: permissionStatus } = await Location.requestForegroundPermissionsAsync();
      if (permissionStatus !== "granted") {
        setStatus("denied");
        return null;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const result = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setCoords(result);
      setStatus("granted");
      return result;
    } catch {
      setStatus("error");
      return null;
    }
  }, []);

  return { status, coords, requestLocation };
}
