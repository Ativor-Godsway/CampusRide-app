import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Location from "expo-location";
import { useQuery } from "@tanstack/react-query";
import { pathLengthMeters, pointAlongPath, type ArrivalSample, type LatLng } from "@rida/shared";
import { getZones, useAuth } from "@rida/mobile-shared";
import { zonesQueryKey } from "./zones";

/**
 * Where the driver is — ONE source for everything that needs it: the zone
 * the server has for them (lib/presence), distances on "Requests near you",
 * the trip map, auto-arrival at a stop and the live location riders see.
 *
 * In a development build it can be switched to a FAKE position (Account →
 * Developer → Fake location): pick a campus zone and the app pretends to be
 * there, and can "drive" along the route to the next stop. That makes
 * distances, ETAs and auto-arrival testable from anywhere.
 *
 * The fake is impossible in a release build: every path to it is behind
 * React Native's __DEV__, which is the constant `false` in a release bundle,
 * so the code is stripped when the app is built and `fake` is always null.
 */
const FAKE_LOCATION_AVAILABLE = typeof __DEV__ !== "undefined" && __DEV__;

/** How fast the fake car drives (~30 km/h — campus roads). */
const FAKE_SPEED_METERS_PER_SECOND = 8;
const FAKE_TICK_MS = 1_000;

export interface FakeLocationControls {
  /** The zone the fake position starts from, or null when the fake is off. */
  zoneId: string | null;
  /** Turn the fake on at a zone, or off with null. */
  setZone: (zoneId: string | null) => void;
  /** Drive along a path (e.g. the route to the next stop); null stops. */
  driveAlong: (path: LatLng[] | null) => void;
  driving: boolean;
}

interface DriverLocation {
  /** The latest position (real GPS, or the fake one), or null if unknown. */
  position: LatLng | null;
  /** The same fix with its speed and time, for automatic arrival. */
  sample: ArrivalSample | null;
  /** The best position available right now, waiting briefly for the OS's last known fix. */
  currentOrLastKnown: () => Promise<LatLng | null>;
  /** True while the position shown is the dev-only fake. */
  isFake: boolean;
  /** Fake-location controls — always null in a release build. */
  fake: FakeLocationControls | null;
  /** Ask for live tracking while `active` (see useLocationDemand). */
  demand: (key: string, active: boolean) => void;
}

const LocationContext = createContext<DriverLocation | null>(null);

export function useDriverLocation(): DriverLocation {
  const value = useContext(LocationContext);
  if (!value) throw new Error("useDriverLocation must be used inside DriverLocationProvider");
  return value;
}

/**
 * Keeps GPS tracking on while `active` (online, or on a trip). Tracking is
 * off when nobody needs it, to save battery.
 */
export function useLocationDemand(key: string, active: boolean): void {
  const { demand } = useDriverLocation();
  useEffect(() => {
    demand(key, active);
    return () => demand(key, false);
  }, [demand, key, active]);
}

const LAST_KNOWN_MAX_AGE_MS = 10 * 60_000;

export function DriverLocationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isDriver = user?.role === "DRIVER";
  const [realSample, setRealSample] = useState<ArrivalSample | null>(null);
  const [demanders, setDemanders] = useState<ReadonlySet<string>>(new Set());

  // ─── Real GPS ─────────────────────────────────────────────────────────
  const tracking = isDriver && demanders.size > 0;
  useEffect(() => {
    if (!tracking) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    void (async () => {
      const perm = await Location.getForegroundPermissionsAsync();
      if (cancelled || perm.status !== "granted") return;
      const subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5_000, distanceInterval: 10 },
        (pos) =>
          setRealSample({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            speed: pos.coords.speed,
            at: pos.timestamp || Date.now(),
          }),
      );
      if (cancelled) subscription.remove();
      else sub = subscription;
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [tracking]);

  const demand = useCallback((key: string, active: boolean) => {
    setDemanders((prev) => {
      if (active === prev.has(key)) return prev;
      const next = new Set(prev);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // ─── Dev-only fake ────────────────────────────────────────────────────
  const [fakeZoneId, setFakeZoneId] = useState<string | null>(null);
  const [fakeSample, setFakeSample] = useState<ArrivalSample | null>(null);
  const [driving, setDriving] = useState(false);
  const driveTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const { data: zones } = useQuery({
    queryKey: zonesQueryKey,
    queryFn: getZones,
    enabled: FAKE_LOCATION_AVAILABLE && isDriver,
    staleTime: Infinity,
  });

  const stopDriving = useCallback(() => {
    if (driveTimer.current) clearInterval(driveTimer.current);
    driveTimer.current = null;
    setDriving(false);
  }, []);

  const setZone = useCallback(
    (zoneId: string | null) => {
      if (!FAKE_LOCATION_AVAILABLE) return;
      stopDriving();
      setFakeZoneId(zoneId);
      const zone = zoneId ? zones?.find((z) => z.id === zoneId) : undefined;
      setFakeSample(zone ? { latitude: zone.latitude, longitude: zone.longitude, speed: 0, at: Date.now() } : null);
    },
    [zones, stopDriving],
  );

  const driveAlong = useCallback(
    (path: LatLng[] | null) => {
      if (!FAKE_LOCATION_AVAILABLE) return;
      stopDriving();
      if (!path || path.length < 2) return;
      const total = pathLengthMeters(path);
      let travelled = 0;
      setDriving(true);
      driveTimer.current = setInterval(() => {
        travelled = Math.min(total, travelled + FAKE_SPEED_METERS_PER_SECOND * (FAKE_TICK_MS / 1000));
        const point = pointAlongPath(path, travelled);
        const arrived = travelled >= total;
        if (point) setFakeSample({ ...point, speed: arrived ? 0 : FAKE_SPEED_METERS_PER_SECOND, at: Date.now() });
        if (arrived) stopDriving();
      }, FAKE_TICK_MS);
    },
    [stopDriving],
  );

  useEffect(() => stopDriving, [stopDriving]);

  // A parked fake car keeps "reporting" every few seconds, like a real phone,
  // so time-based checks (automatic arrival) see it staying put.
  useEffect(() => {
    if (!FAKE_LOCATION_AVAILABLE || fakeZoneId === null || driving) return;
    const t = setInterval(() => setFakeSample((s) => (s ? { ...s, speed: 0, at: Date.now() } : s)), 3_000);
    return () => clearInterval(t);
  }, [fakeZoneId, driving]);

  const isFake = FAKE_LOCATION_AVAILABLE && fakeZoneId !== null && fakeSample !== null;
  const sample = isFake ? fakeSample : realSample;
  const lat = sample?.latitude;
  const lng = sample?.longitude;
  // Only a moved fix is a new position (a re-reported one isn't), so
  // position-driven work doesn't rerun every few seconds for nothing.
  const position = useMemo<LatLng | null>(
    () => (lat === undefined || lng === undefined ? null : { latitude: lat, longitude: lng }),
    [lat, lng],
  );

  const positionRef = useRef(position);
  positionRef.current = position;
  const currentOrLastKnown = useCallback(async (): Promise<LatLng | null> => {
    if (positionRef.current) return positionRef.current;
    try {
      const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
      return last ? { latitude: last.coords.latitude, longitude: last.coords.longitude } : null;
    } catch {
      return null;
    }
  }, []);

  const fake = useMemo<FakeLocationControls | null>(
    () => (FAKE_LOCATION_AVAILABLE ? { zoneId: fakeZoneId, setZone, driveAlong, driving } : null),
    [fakeZoneId, setZone, driveAlong, driving],
  );

  const value = useMemo(
    () => ({ position, sample, currentOrLastKnown, isFake, fake, demand }),
    [position, sample, currentOrLastKnown, isFake, fake, demand],
  );

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}
