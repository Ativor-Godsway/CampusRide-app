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
import { Alert } from "react-native";
import * as Location from "expo-location";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isTransientRequestFailure,
  nearestZone,
  planZoneUpdate,
  type LatLng,
  type ZoneUpdateState,
} from "@rida/shared";
import {
  errorMessage,
  getZones,
  setDriverAvailability,
  updateDriverZone,
  useAuth,
} from "@rida/mobile-shared";
import { driverActiveRideQueryKey } from "./activeTrip";
import { eligibleRidesQueryKey } from "./requests";

/**
 * The driver's online status, owned once for the whole app so the toggle,
 * Home, "Requests near you" and (later) offers all agree.
 *
 * The toggle is optimistic: the switch flips on tap, the request goes in the
 * background, and only a failure flips it back, with a message. A server
 * that is still waking up (Render cold start) is retried quietly instead of
 * being reported as a failure; `waking` lets the UI say so.
 *
 * While online, the driver's zone follows their GPS (throttled, see
 * planZoneUpdate), because dispatch only shows a driver requests near the
 * zone the server has for them.
 */
interface DriverPresence {
  /** What the switch shows: the driver's latest choice, before the server confirms it. */
  isOnline: boolean;
  /** A retry is under way because the server didn't answer in time. */
  waking: boolean;
  /** The latest GPS fix while online (for distances), or null. */
  position: LatLng | null;
  toggle: () => void;
}

const PresenceContext = createContext<DriverPresence | null>(null);

export function useDriverPresence(): DriverPresence {
  const value = useContext(PresenceContext);
  if (!value) throw new Error("useDriverPresence must be used inside DriverPresenceProvider");
  return value;
}

export const zonesQueryKey = ["zones"] as const;

/** Long enough for a sleeping server to wake; the switch has already flipped. */
const AVAILABILITY_TIMEOUT_MS = 20_000;
/** Pauses before each retry of a transient failure. Four attempts in all. */
const RETRY_DELAYS_MS = [1_500, 3_000, 5_000];
/** A last-known fix older than this is ignored for the zone (the driver may have moved far). */
const LAST_KNOWN_MAX_AGE_MS = 10 * 60_000;

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function DriverPresenceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isDriver = user?.role === "DRIVER" && Boolean(user.driver?.isApproved);

  const [isOnline, setIsOnline] = useState(false);
  // True once the server has agreed with `isOnline` (zone tracking waits for it).
  const [confirmed, setConfirmed] = useState(true);
  const [waking, setWaking] = useState(false);
  const [position, setPosition] = useState<LatLng | null>(null);

  const isOnlineRef = useRef(false);
  const seqRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const zoneStateRef = useRef<ZoneUpdateState>({ lastSentZoneId: null, lastSentAt: null });

  const applyOnline = useCallback((next: boolean) => {
    isOnlineRef.current = next;
    setIsOnline(next);
  }, []);

  // Start from what the server says (the app may have been closed while
  // online), once per signed-in driver; signing out resets to offline.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    const id = isDriver ? user!.id : null;
    if (seededForRef.current === id) return;
    seededForRef.current = id;
    seqRef.current += 1;
    applyOnline(id !== null && Boolean(user?.driver?.isOnline));
    setConfirmed(true);
    setWaking(false);
    setPosition(null);
    zoneStateRef.current = { lastSentZoneId: null, lastSentAt: null };
  }, [isDriver, user, applyOnline]);

  const { data: zones } = useQuery({
    queryKey: zonesQueryKey,
    queryFn: getZones,
    enabled: isDriver,
    staleTime: Infinity,
  });

  /**
   * Sends one availability change, retrying transient failures. Requests run
   * one after another (so an "off" can never overtake an "on"), and a request
   * made stale by a newer tap stops retrying and reports nothing.
   */
  const sendAvailability = useCallback(
    (seq: number, next: boolean, zoneId: string | undefined) => {
      const run = async () => {
        const current = () => seq === seqRef.current;
        for (let attempt = 0; ; attempt += 1) {
          if (!current()) return;
          try {
            await setDriverAvailability(next, zoneId, { timeoutMs: AVAILABILITY_TIMEOUT_MS });
            if (!current()) return;
            setWaking(false);
            setConfirmed(true);
            zoneStateRef.current = { lastSentZoneId: next ? (zoneId ?? null) : null, lastSentAt: null };
            void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
            void queryClient.invalidateQueries({ queryKey: eligibleRidesQueryKey });
            return;
          } catch (err) {
            if (!current()) return;
            const transient = isTransientRequestFailure({ status: httpStatus(err) });
            if (transient && attempt < RETRY_DELAYS_MS.length) {
              setWaking(true);
              await wait(RETRY_DELAYS_MS[attempt]!);
              continue;
            }
            setWaking(false);
            setConfirmed(true);
            applyOnline(!next);
            Alert.alert(
              next ? "Couldn't go online" : "Couldn't go offline",
              transient
                ? "We couldn't reach CampusRide. Check your connection and try again."
                : errorMessage(err),
            );
            return;
          }
        }
      };
      chainRef.current = chainRef.current.then(run, run);
    },
    [queryClient, applyOnline],
  );

  const toggle = useCallback(() => {
    const next = !isOnlineRef.current;
    const seq = (seqRef.current += 1);
    applyOnline(next);
    setConfirmed(false);

    if (!next) {
      setPosition(null);
      sendAvailability(seq, false, undefined);
      return;
    }

    void (async () => {
      // Permission is usually already granted, so this doesn't wait on anything.
      let perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== "granted") perm = await Location.requestForegroundPermissionsAsync();
      if (seq !== seqRef.current) return;
      if (perm.status !== "granted") {
        applyOnline(false);
        setConfirmed(true);
        Alert.alert("Location required", "Enable location so we can match you with nearby riders.");
        return;
      }

      // The last known fix is instant; a fresh fix refines the zone later.
      let zoneId: string | undefined;
      try {
        const [allZones, last] = await Promise.all([
          queryClient.fetchQuery({ queryKey: zonesQueryKey, queryFn: getZones, staleTime: Infinity }),
          Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }),
        ]);
        if (last) {
          const coords = { latitude: last.coords.latitude, longitude: last.coords.longitude };
          setPosition(coords);
          zoneId = nearestZone(coords.latitude, coords.longitude, allZones)?.id;
        }
      } catch {
        // No zone yet: the first fresh fix sets it.
      }
      sendAvailability(seq, true, zoneId);
    })();
  }, [applyOnline, queryClient, sendAvailability]);

  // ─── Keep the zone current while online ─────────────────────────────────
  const trackZone = isDriver && isOnline && confirmed && Boolean(zones?.length);
  useEffect(() => {
    if (!trackZone || !zones) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latestZoneId: string | null = null;

    const send = async (zoneId: string) => {
      const previous = zoneStateRef.current;
      zoneStateRef.current = { lastSentZoneId: zoneId, lastSentAt: Date.now() };
      try {
        await updateDriverZone(zoneId);
        void queryClient.invalidateQueries({ queryKey: eligibleRidesQueryKey });
      } catch (err) {
        if (cancelled) return;
        if (httpStatus(err) === 409) {
          // The server has this driver offline; show the truth.
          seqRef.current += 1;
          applyOnline(false);
          Alert.alert("You're offline", "Go online again to receive requests.");
          return;
        }
        // Retry on a later fix, still throttled.
        zoneStateRef.current = { ...zoneStateRef.current, lastSentZoneId: previous.lastSentZoneId };
      }
    };

    const schedule = () => {
      if (cancelled) return;
      const plan = planZoneUpdate(zoneStateRef.current, latestZoneId, Date.now());
      if (plan.kind === "send" && latestZoneId) void send(latestZoneId);
      if (plan.kind === "wait" && !timer) {
        timer = setTimeout(() => {
          timer = null;
          schedule();
        }, plan.delayMs);
      }
    };

    void (async () => {
      const perm = await Location.getForegroundPermissionsAsync();
      if (cancelled || perm.status !== "granted") return;
      const subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 10_000, distanceInterval: 25 },
        (pos) => {
          const coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
          setPosition(coords);
          latestZoneId = nearestZone(coords.latitude, coords.longitude, zones)?.id ?? null;
          schedule();
        },
      );
      if (cancelled) subscription.remove();
      else sub = subscription;
    })();

    return () => {
      cancelled = true;
      sub?.remove();
      if (timer) clearTimeout(timer);
    };
  }, [trackZone, zones, queryClient, applyOnline]);

  const value = useMemo(
    () => ({ isOnline: isDriver && isOnline, waking, position, toggle }),
    [isDriver, isOnline, waking, position, toggle],
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}
