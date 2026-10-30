import { useCallback, useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { KEYCHAIN_BACKGROUND_OPTIONS, readKeychain } from "../auth/keychain";

/**
 * Keeping react-native-maps (1.27) from crashing the app on Android.
 *
 * 1. `mapPadding` only once the map is ready. On Android the native
 *    `applyBaseMapPadding` calls `GoogleMap.setPadding` without checking the
 *    map exists: a padding that changes after the view is laid out but before
 *    `onMapReady` (the safe-area insets do, when the app pauses or resumes
 *    while a slow phone is still loading Google Maps) is a fatal
 *    NullPointerException (Sentry CAMPUSRIDE-DRIVER-6). react-native-maps
 *    1.29 checks for it; until we ship a store build with it, every MapView
 *    passes its padding through `paddingWhenReady` (a test enforces it).
 *
 * 2. A map that crashed the app doesn't crash it again on every launch. A
 *    native crash kills the app before any error boundary can help, and the
 *    trip screen opens straight back onto the same map. `useMapLaunchGuard`
 *    notes a map as "loading" until it is ready; if the app stopped while one
 *    was still loading, the next launch shows that screen without the map
 *    (with a button to show it), so the driver can carry on.
 */

export interface MapEdgePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** `ready` from onMapReady: the padding, or nothing before the map exists. */
export function paddingWhenReady(ready: boolean, padding: MapEdgePadding): MapEdgePadding | undefined {
  return ready ? padding : undefined;
}

/** Whether this MapView instance has fired onMapReady. */
export function useMapReady(): { ready: boolean; onMapReady: () => void } {
  const [ready, setReady] = useState(false);
  const onMapReady = useCallback(() => setReady(true), []);
  return { ready, onMapReady };
}

const STORE_KEY = "campusride.maps-loading";

let lastLaunch: Promise<ReadonlySet<string>> | null = null;
let loadingNow = new Set<string>();
let writes: Promise<unknown> = Promise.resolve();

/** Saves which maps are loading, one write after another (so the last state wins). */
function save(): void {
  const value = JSON.stringify([...loadingNow]);
  writes = writes
    .then(() =>
      loadingNow.size
        ? SecureStore.setItemAsync(STORE_KEY, value, KEYCHAIN_BACKGROUND_OPTIONS)
        : SecureStore.deleteItemAsync(STORE_KEY),
    )
    .catch(() => undefined);
}

/** The maps that were still loading when the app last stopped (read once per launch). */
export function mapsLoadingAtLastStop(): Promise<ReadonlySet<string>> {
  lastLaunch ??= readKeychain(STORE_KEY)
    .then((raw) => {
      const names = raw ? (JSON.parse(raw) as unknown) : [];
      return new Set(Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : []);
    })
    .catch(() => new Set<string>());
  return lastLaunch;
}

/** Tests only: forget what was read and what is loading. */
export function resetMapLaunchGuardForTests(): void {
  lastLaunch = null;
  loadingNow = new Set();
  writes = Promise.resolve();
}

/**
 * For one map (by a stable name, e.g. "driver-trip"): `showMap` is null until
 * we know, false when that map was still loading when the app last stopped
 * (likely a crash), else true. Pass `onMapReady` to the MapView; call
 * `showAnyway` from a "Show map" button.
 */
export function useMapLaunchGuard(name: string): {
  showMap: boolean | null;
  onMapReady: () => void;
  showAnyway: () => void;
} {
  const [showMap, setShowMap] = useState<boolean | null>(null);
  const ready = useRef(false);

  useEffect(() => {
    let live = true;
    void mapsLoadingAtLastStop().then((last) => {
      if (live) setShowMap(!last.has(name));
    });
    return () => {
      live = false;
    };
  }, [name]);

  // Loading from when the map is shown until it's ready (or the screen closes).
  useEffect(() => {
    if (!showMap) return;
    ready.current = false;
    loadingNow.add(name);
    save();
    return () => {
      if (loadingNow.delete(name)) save();
    };
  }, [name, showMap]);

  const onMapReady = useCallback(() => {
    if (ready.current) return;
    ready.current = true;
    if (loadingNow.delete(name)) save();
  }, [name]);

  const showAnyway = useCallback(() => setShowMap(true), []);
  return { showMap, onMapReady, showAnyway };
}
