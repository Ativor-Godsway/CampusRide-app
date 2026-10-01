import { useEffect, useMemo, useRef } from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  DRIVER_CLIENT_EVENTS,
  INITIAL_ARRIVAL_STATE,
  stepArrival,
  type ArrivalSample,
  type ArrivalState,
} from "@rida/shared";
import { useQueryClient } from "@tanstack/react-query";
import { RIDE_EVENTS, type RideStatusPayload } from "@rida/shared";
import { getRideSocket, subscribeToRide, unsubscribeFromRide, type RideWithZones } from "@rida/mobile-shared";
import { driverActiveRideQueryKey, useDriverActiveTrip } from "./activeTrip";
import { useDriverLocation, useLocationDemand } from "./location";
import { configureTripActions, overlayPassengers, runPassengerAction, useTripActions } from "./tripActions";
import { useZones } from "./zones";

/** Riders see the driver move: one position every few seconds. */
const LOCATION_SEND_MS = 4_000;
/** How often arrival is re-checked while parked (the phone sends few fixes when it isn't moving). */
const ARRIVAL_TICK_MS = 2_000;
/**
 * No new fix for this long means the car hasn't moved. While moving, the
 * phone reports about every 5 s (lib/location: timeInterval 5 s, 10 m), so
 * this must be longer than that — or driving past would look like stopping.
 */
const STILL_AFTER_MS = 7_000;
const KEEP_AWAKE_TAG = "campusride-trip";

/**
 * Everything a trip needs while the app is open, on EVERY screen — not just
 * the trip screen (Stage 3 rule 0):
 *
 * - the driver's live position goes to the riders every few seconds;
 * - automatic arrival: when the driver stays within 60 m of a waiting rider's
 *   pickup, moving slowly, for 10 s (see stepArrival in @rida/shared), that
 *   rider is marked ARRIVED through the same action as the "I'm here" button
 *   — so the rider is told exactly the same way;
 * - the screen stays awake (no background location yet: that needs the
 *   Android pilot build, so the app has to stay open and on).
 *
 * Mounted once in the root layout; renders nothing.
 */
export function TripRuntime() {
  const queryClient = useQueryClient();
  const { data: trip } = useDriverActiveTrip();

  // The action store syncs in the background through the shared cache: a
  // refetch after each answered action, and trip data it fetched itself.
  useEffect(() => {
    configureTripActions({
      refresh: () => {
        void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
        void queryClient.invalidateQueries({ queryKey: ["fillSuggestions"] });
      },
      onRide: (ride: RideWithZones | null) => queryClient.setQueryData(driverActiveRideQueryKey, ride),
    });
  }, [queryClient]);
  const actions = useTripActions();
  const { data: zones = [] } = useZones();
  const location = useDriverLocation();
  const rideId = trip?.id ?? null;
  useLocationDemand("trip-runtime", rideId !== null);

  // Keep the screen on for the whole trip.
  useEffect(() => {
    if (!rideId) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [rideId]);

  // Server-pushed trip changes (the rider cancels, the trip ends) reach
  // every screen in a second or two: listen on the trip's room, and apply an
  // ending straight to the cache instead of waiting for a refetch.
  useEffect(() => {
    if (!rideId) return;
    const socket = getRideSocket();
    const join = () => subscribeToRide(rideId);
    const onStatus = (payload: RideStatusPayload) => {
      if (payload.rideId !== rideId) return;
      if (payload.status === "CANCELLED" || payload.status === "COMPLETED") {
        queryClient.setQueryData(driverActiveRideQueryKey, null);
      }
      void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
    };
    join();
    socket.on("connect", join); // rooms are forgotten on reconnect
    socket.on(RIDE_EVENTS.STATUS, onStatus);
    return () => {
      socket.off("connect", join);
      socket.off(RIDE_EVENTS.STATUS, onStatus);
      unsubscribeFromRide(rideId);
    };
  }, [rideId, queryClient]);

  // Live location to the ride room.
  const sampleRef = useRef<ArrivalSample | null>(location.sample);
  sampleRef.current = location.sample;
  useEffect(() => {
    if (!rideId) return;
    const socket = getRideSocket();
    const send = () => {
      const s = sampleRef.current;
      if (s) socket.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId, lat: s.latitude, lng: s.longitude });
    };
    send();
    const t = setInterval(send, LOCATION_SEND_MS);
    return () => clearInterval(t);
  }, [rideId]);

  // ─── Automatic arrival ──────────────────────────────────────────────────
  // Every rider still WAITING for pickup (with this device's not-yet-sent
  // actions applied, so a rider just marked by hand isn't marked twice).
  const waiting = useMemo(() => {
    if (!trip) return [];
    const byId = new Map(zones.map((z) => [z.id, z]));
    return overlayPassengers(trip.id, trip.passengers)
      .filter((p) => p.status === "WAITING" && !p.id.startsWith("pending:") && p.pickupZoneId)
      .map((p) => ({ id: p.id, zone: byId.get(p.pickupZoneId!) }))
      .filter((p): p is { id: string; zone: NonNullable<typeof p.zone> } => p.zone !== undefined);
    // actions.seats changes when an overlay does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, zones, actions.seats, actions.adds]);

  const detectorsRef = useRef(new Map<string, ArrivalState>());
  const firedRef = useRef(new Set<string>());
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  useEffect(() => {
    if (!rideId) {
      detectorsRef.current.clear();
      return;
    }
    let lastAt = 0;
    const evaluate = (sample: ArrivalSample) => {
      for (const p of waitingRef.current) {
        if (firedRef.current.has(p.id)) continue;
        const { state, arrived } = stepArrival(detectorsRef.current.get(p.id) ?? INITIAL_ARRIVAL_STATE, sample, p.zone);
        detectorsRef.current.set(p.id, state);
        if (arrived) {
          firedRef.current.add(p.id);
          runPassengerAction(rideId, p.id, "arrived");
        }
      }
    };
    const tick = () => {
      const s = sampleRef.current;
      if (!s) return;
      const now = Date.now();
      // A fix we've already used is re-checked as "still here, not moving".
      const sample = s.at > lastAt ? s : { ...s, at: now, speed: now - s.at > STILL_AFTER_MS ? 0 : s.speed };
      lastAt = Math.max(lastAt, s.at);
      evaluate(sample);
    };
    tick();
    const t = setInterval(tick, ARRIVAL_TICK_MS);
    return () => clearInterval(t);
  }, [rideId]);

  return null;
}
