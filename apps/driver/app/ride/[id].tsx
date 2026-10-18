import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Redirect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import {
  CAR_SEATS,
  DEFAULT_OFFER_SECONDS,
  chooseTripSource,
  summaryGivesWay,
  NO_SHOW_AFTER_MS,
  classifyActionFailure,
  decodePolyline,
  trimPathToPosition,
  DRIVER_EVENTS,
  etaToStopMinutes,
  formatCedis,
  formatWait,
  indexRoutes,
  isAtStop,
  AT_STOP_RADIUS_METERS,
  PIN_ARRIVAL_RADIUS_METERS,
  haversineDistanceMeters,
  routeStops,
  nextStopInstruction,
  noShowAvailableAt,
  riderName,
  stepToast,
  isOutsideServiceArea,
  planTripStops,
  routeAttribution,
  seatStates,
  splitFare,
  tripPath,
  type LatLng,
  type TripStop,
  type TripZone,
} from "@rida/shared";
import {
  Button,
  Card,
  Illustration,
  LoadingState,
  Screen,
  SessionRestoringScreen,
  Text,
  callPhone,
  colors,
  errorStatus,
  getAddRiderPreview,
  getFillSuggestions,
  serverReason,
  getRideSocket,
  goHome as goToHomeTab,
  openDirections,
  radii,
  shadows,
  spacing,
  typography,
  useAuth,
  useCountUp,
  useToast,
  useLiveRoute,
  type FillSuggestion,
  type PassengerInCar,
  type RideWithZones,
} from "@rida/mobile-shared";
import { driverActiveRideQueryKey, useDriverActiveTrip } from "../../lib/activeTrip";
import { useDriverLocation, useLocationDemand } from "../../lib/location";
import { useZoneRoutes, useZones } from "../../lib/zones";
import { CountdownBar } from "../../components/offers/CountdownBar";
import { alertNewOffer, tapFeedback } from "../../lib/offerAlert";
import {
  claimPassengerId,
  clearClaim,
  runRejectOffer,
  overlayPassengers,
  runAddRider,
  runPassengerAction,
  settleWith,
  useTripActions,
} from "../../lib/tripActions";
import { TripMap, type TripPreviewOverlay } from "../../components/trip/TripMap";
import { SlideToConfirm } from "../../components/trip/SlideToConfirm";
import { StopListSheet } from "../../components/trip/StopListSheet";
import { AddRiderSheet } from "../../components/trip/AddRiderSheet";
import { SeatDots } from "../../components/trip/SeatDots";
import { RateRidersPanel } from "../../components/trip/RateRidersPanel";

const SEAT_LEGEND_KEY = "campusride.driver.seatLegendSeen";

/** The trip screen checks its trip more often than the rest of the app (a rider may cancel). */
const TRIP_POLL_MS = 5_000;

interface DoneSummary {
  rideId: string;
  /** What the riders paid in total (cash to collect, or MoMo). */
  totalPesewas: number;
  driverSharePesewas: number;
  commissionPesewas: number;
  cash: boolean;
}

/** Ticks once a second while `on` — for the pickup wait timer. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * The trip screen — one screen for Ride alone and Shared trips, built around
 * STOPS (design sketches 4, 5, 7, 8):
 *
 * - a full map with the driver, every stop numbered in order, and the route;
 * - the NEXT STOP card with Navigate and Call, and ONE slide action
 *   ("Ama picked up", "Cash collected" with the amount large);
 * - "I'm here" as the fallback for automatic arrival, and "Rider didn't show"
 *   three minutes after arriving;
 * - "N more stops" opens the ordered stop list; seat dots; "Add a rider"
 *   (before the first pickup) opens a compact sheet.
 *
 * Every action is optimistic (lib/tripActions): the screen moves at once,
 * the request follows in the background and is retried quietly; only a real
 * refusal puts it back, with the server's reason.
 */
export default function TripScreen() {
  const { id: rideId, preview: previewParam } = useLocalSearchParams<{ id: string; preview?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { isLoading: sessionLoading, isAuthenticated, user } = useAuth();

  const { data: activeRide, isLoading } = useDriverActiveTrip(TRIP_POLL_MS, { includeFinished: true });
  const actions = useTripActions();
  const { data: zoneList = [] } = useZones();
  const { data: storedRoutes = [] } = useZoneRoutes();
  const location = useDriverLocation();
  useLocationDemand("trip", true);

  const serverRide: RideWithZones | null = activeRide && activeRide.id === rideId ? activeRide : null;
  const claim = actions.claim?.rideId === rideId ? actions.claim : null;
  const zones = useMemo(() => new Map<string, TripZone>(zoneList.map((z) => [z.id, z])), [zoneList]);

  // Just accepted and the server hasn't confirmed yet: the trip is built from
  // the request itself, so the screen is the full trip at once (no
  // "Confirming…"). Its rider's seat is provisional; steps taken on it wait
  // in the action queue until the real seat id arrives.
  // Only until the server's trip arrives: once the server has listed it,
  // a missing trip means it ENDED — never fall back to this (chooseTripSource).
  const source = chooseTripSource({
    hasServerRide: Boolean(serverRide),
    claimState: claim?.state ?? null,
    serverSeen: claim?.serverSeen ?? false,
  });
  const provisional = useMemo<RideWithZones | null>(() => {
    if (source !== "provisional" || !claim) return null;
    const req = claim.request;
    const pickupZone = zones.get(req.pickupZoneId);
    const dropoffZone = zones.get(req.dropoffZoneId);
    if (!pickupZone || !dropoffZone) return null;
    return {
      id: req.rideId,
      type: req.type,
      status: "MATCHED",
      // Cash-only launch: every ride is cash until MoMo is switched on.
      paymentMethod: "CASH",
      riderId: "",
      occupancy: req.seats ?? 1,
      pickupZoneId: req.pickupZoneId,
      dropoffZoneId: req.dropoffZoneId,
      pickupZone,
      dropoffZone,
      passengers: [
        {
          id: claimPassengerId(req.rideId),
          riderId: "",
          riderName: req.riderFirstName ?? null,
          riderPhone: null,
          pickupZoneId: req.pickupZoneId,
          dropoffZoneId: req.dropoffZoneId,
          pickupZoneName: req.pickupZoneName,
          dropoffZoneName: req.dropoffZoneName,
          // Names only until the server confirms (seconds); then the exact pins.
          pickupLabel: req.pickupPlaceName ?? null,
          dropoffLabel: req.dropoffPlaceName ?? null,
          lockedFare: req.farePesewas,
          status: "WAITING",
          arrivedAt: null,
        },
      ],
    } as unknown as RideWithZones;
  }, [source, claim, zones]);
  const ride: RideWithZones | null = serverRide ?? provisional;

  // Drop optimistic overlays once the server has caught up.
  useEffect(() => {
    if (serverRide) settleWith(serverRide.id, serverRide.passengers);
  }, [serverRide]);

  const routes = useMemo(() => indexRoutes(storedRoutes), [storedRoutes]);
  const passengers: PassengerInCar[] = useMemo(
    () => (ride ? overlayPassengers(ride.id, ride.passengers) : []),
    // actions changes when an overlay does
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ride, actions.seats, actions.adds],
  );
  // Far outside the service area (testing off campus), the driver's real
  // position is left out of the trip: the map frames only the stops, the
  // route starts at the first stop, and no ETA is invented from 120 km away.
  const farFromCampus = isOutsideServiceArea(location.position, zoneList);
  const position = farFromCampus ? null : location.position;
  const plan = useMemo(
    () =>
      planTripStops({
        passengers: passengers
          .filter((p) => p.pickupZoneId && p.dropoffZoneId)
          .map((p) => ({ ...p, pickupZoneId: p.pickupZoneId!, dropoffZoneId: p.dropoffZoneId! })),
        zones,
        from: position,
      }),
    [passengers, zones, position],
  );
  const next: TripStop | undefined = plan.upcoming[0];
  // The road through every stop's exact pin (OSRM via the server), asked
  // for once and re-asked only if the driver leaves it; the stored zone
  // roads are the instant fallback.
  const stopPoints = useMemo(() => plan.upcoming.slice(0, 9).map((s) => s.point), [plan.upcoming]);
  const live = useLiveRoute({ from: position, stops: stopPoints, enabled: stopPoints.length > 0 });
  const fallbackPath = useMemo(
    () => tripPath(position, routeStops(plan.upcoming), zoneList, routes),
    [position, plan.upcoming, zoneList, routes],
  );
  const path = live.path ?? fallbackPath;
  const etaMinutes =
    next && live.secondsToFirstStop !== null && position
      ? Math.max(1, Math.round(live.secondsToFirstStop / 60))
      : next
        ? etaToStopMinutes(position, next.zone, zoneList, routes)
        : null;
  // Arrived: within 50 m of an exact pin, or the zone radius for a ride booked without one.
  const atNextStop = next
    ? isAtStop(position, next.point, next.exact ? PIN_ARRIVAL_RADIUS_METERS : AT_STOP_RADIUS_METERS)
    : false;
  /** The road to the next stop only (the fake drive follows it). */
  const pathToNext = useMemo(() => {
    if (!next || path.length < 2) return null;
    let best = path.length - 1;
    let bestD = Infinity;
    path.forEach((p, i) => {
      const d = haversineDistanceMeters(p, next.point);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const cut = path.slice(0, best + 1);
    return cut.length >= 2 ? [...cut, next.point] : null;
  }, [next, path]);
  const mapStops = useMemo(
    () =>
      plan.upcoming.map((s) => ({
        key: s.key,
        kind: s.kind,
        riderFirstName: s.riderFirstName,
        zone: { name: s.label, latitude: s.point.latitude, longitude: s.point.longitude },
      })),
    [plan.upcoming],
  );

  // ─── Done: the last drop-off (shown at once, optimistically) ─────────────
  const [done, setDone] = useState<DoneSummary | null>(null);
  const hadStopsRef = useRef(false);
  useEffect(() => {
    if (!ride) return;
    if (plan.upcoming.length > 0) {
      hadStopsRef.current = true;
      // Back to the trip only if the SERVER still has stops to do (it
      // refused a drop-off) — never for a provisional trip.
      if (done?.rideId === ride.id && summaryGivesWay({ source, upcomingStops: plan.upcoming.length })) setDone(null);
      return;
    }
    if (!hadStopsRef.current || done) return;
    const carried = passengers.filter((p) => p.status === "DROPPED_OFF");
    if (carried.length === 0) return;
    const total = carried.reduce((sum, p) => sum + (p.lockedFare ?? 0), 0);
    const { driverShare, commission } = splitFare(total);
    setDone({
      rideId: ride.id,
      totalPesewas: total,
      driverSharePesewas: driverShare,
      commissionPesewas: commission,
      cash: ride.paymentMethod === "CASH",
    });
  }, [ride, plan.upcoming.length, passengers, done, source]);

  // Live location to the riders and automatic arrival run on every screen
  // during a trip (lib/tripRuntime), not just here.
  const positionRef = useRef<LatLng | null>(position);
  positionRef.current = position;

  // Refusals: the server's reason, in a banner the driver dismisses.
  const [refusal, setRefusal] = useState<string | null>(null);
  const lastRefusalId = useRef(actions.refusal?.id ?? 0);
  useEffect(() => {
    if (actions.refusal && actions.refusal.id !== lastRefusalId.current) {
      lastRefusalId.current = actions.refusal.id;
      setRefusal(actions.refusal.message);
    }
  }, [actions.refusal]);

  // ─── Adding riders (Shared, before the first pickup) ─────────────────────
  // Riders can join a shared car before departure and, within the 5-minute
  // detour limit the server enforces, while it's moving (sketch 6).
  const canAddRiders = Boolean(
    serverRide &&
      serverRide.type === "SHARED" &&
      (serverRide.status === "MATCHED" || serverRide.status === "ARRIVED" || serverRide.status === "IN_PROGRESS"),
  );
  const activeSeats = passengers.filter((p) => p.status === "WAITING" || p.status === "ARRIVED" || p.status === "PICKED_UP").length;
  const freeSeats = Math.max(0, CAR_SEATS - activeSeats);
  const { data: fill, refetch: refetchFill } = useQuery({
    queryKey: ["fillSuggestions", ride?.id],
    queryFn: () => getFillSuggestions(ride!.id),
    enabled: canAddRiders,
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (!canAddRiders) return;
    const socket = getRideSocket();
    const onBroadcast = () => void refetchFill();
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [canAddRiders, refetchFill]);
  const suggestions = (fill?.suggestions ?? []).filter((s) => !actions.adds[s.requestRideId]);

  // ─── Route preview before adding a rider ─────────────────────────────────
  // A rider who fits the route is offered automatically (once); any waiting
  // rider can be previewed from the "Add rider" sheet. The server works out
  // where they'd slot in (same ordering as this screen), the new route, the
  // time it adds and the fare.
  const [previewing, setPreviewing] = useState<{ suggestion: FillSuggestion; manual: boolean } | null>(null);
  const [committing, setCommitting] = useState(false);
  const skippedRef = useRef(new Set<string>());
  const previewId = previewing?.suggestion.requestRideId ?? null;

  useEffect(() => {
    if (!canAddRiders || previewing || freeSeats === 0) return;
    const offer = suggestions.find((s) => s.compatible && !skippedRef.current.has(s.requestRideId));
    if (offer) setPreviewing({ suggestion: offer, manual: false });
  }, [canAddRiders, previewing, freeSeats, suggestions]);

  // "See route" on a Home request opens this screen with ?preview=<request>.
  const openedFromParamRef = useRef<string | null>(null);
  useEffect(() => {
    if (!previewParam || openedFromParamRef.current === previewParam || !canAddRiders) return;
    const match = (fill?.suggestions ?? []).find((s) => s.requestRideId === previewParam);
    if (!match) return;
    openedFromParamRef.current = previewParam;
    setCommitting(false);
    setPreviewing({ suggestion: match, manual: true });
  }, [previewParam, canAddRiders, fill]);

  const closePreview = useCallback((message?: string) => {
    setPreviewing((current) => {
      if (current) skippedRef.current.add(current.suggestion.requestRideId);
      return null;
    });
    setCommitting(false);
    if (message) setRefusal(message);
  }, []);

  /** Skip (or the countdown ran out) on an automatic offer: recorded, never offered again. */
  const passOnOffer = useCallback(
    (reason: "DECLINED" | "TIMED_OUT") => {
      if (previewing && !previewing.manual) runRejectOffer(previewing.suggestion.requestRideId, reason);
      closePreview();
    },
    [previewing, closePreview],
  );

  const previewQuery = useQuery({
    queryKey: ["addPreview", ride?.id, previewId],
    queryFn: () => getAddRiderPreview(ride!.id, previewId!, positionRef.current),
    enabled: Boolean(ride && previewId && canAddRiders && !committing),
    refetchInterval: 15_000,
    // Keep showing the last answer while a refresh is on its way (no flicker).
    placeholderData: (previous) => previous,
    retry: (count, err) => classifyActionFailure(errorStatus(err)) === "retry" && count < 3,
  });
  const previewData = previewQuery.data?.requestRideId === previewId ? previewQuery.data : undefined;

  // ─── Mid-trip OFFER: a rider who fits, offered with a countdown ─────────
  // Only once the server's preview has passed the detour check (seats and
  // the 5-minute limit): an offer that would break it is never shown. It
  // counts down like a Home offer; Skip or running out records it on the
  // server so this rider isn't offered to this driver again. A rider the
  // driver opened themselves (Add rider / See route) has no countdown.
  const autoOffer = previewing !== null && !previewing.manual;
  const [offerClock, setOfferClock] = useState<{ rideId: string; shownAt: number; deadline: number } | null>(null);
  useEffect(() => {
    if (!autoOffer || !previewData || offerClock?.rideId === previewData.requestRideId) return;
    const shownAt = Date.now();
    const own = shownAt + DEFAULT_OFFER_SECONDS * 1000;
    const requestEnds = Date.parse(previewData.expiresAt);
    setOfferClock({ rideId: previewData.requestRideId, shownAt, deadline: Number.isFinite(requestEnds) ? Math.min(own, requestEnds) : own });
    alertNewOffer();
  }, [autoOffer, previewData, offerClock?.rideId]);
  useEffect(() => {
    if (!autoOffer) setOfferClock(null);
  }, [autoOffer]);
  useEffect(() => {
    if (!offerClock || committing) return;
    const t = setTimeout(() => passOnOffer("TIMED_OUT"), Math.max(0, offerClock.deadline - Date.now()));
    return () => clearTimeout(t);
  }, [offerClock, committing, passOnOffer]);

  // A refusal (the request was taken, the car filled up) ends the preview;
  // say why only if the driver opened it themselves.
  useEffect(() => {
    if (!previewQuery.error || classifyActionFailure(errorStatus(previewQuery.error)) !== "refused") return;
    closePreview(previewing?.manual ? (serverReason(previewQuery.error) ?? "That rider can't be added now.") : undefined);
  }, [previewQuery.error, previewing?.manual, closePreview]);

  // The offer runs out when the request does.
  const expiresAt = previewData ? Date.parse(previewData.expiresAt) : null;
  useEffect(() => {
    if (expiresAt === null || committing) return;
    const t = setTimeout(() => closePreview(), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [expiresAt, committing, closePreview]);

  // Once the car leaves (first pickup) or fills up, a preview no longer applies.
  useEffect(() => {
    if (previewing && !committing && (!canAddRiders || freeSeats === 0)) closePreview();
  }, [previewing, committing, canAddRiders, freeSeats, closePreview]);

  const proposedFull = useMemo(
    () => (previewData ? decodePolyline(previewData.proposedPolyline) : []),
    // Decode only when the route itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewData?.proposedPolyline],
  );
  const previewOverlay = useMemo<TripPreviewOverlay | null>(() => {
    if (!previewData) return null;
    return {
      stops: previewData.stops.map((st) => ({
        key: st.key,
        kind: st.kind,
        isNew: st.isNew,
        riderFirstName: st.riderFirstName,
        zone: { name: st.label ?? st.zoneName, latitude: st.latitude, longitude: st.longitude },
      })),
      // What's ahead only: cut off what the driver has already driven.
      path: position && proposedFull.length >= 2 ? trimPathToPosition(proposedFull, position) : proposedFull,
      committing,
    };
  }, [previewData, proposedFull, position, committing]);

  // "Add": the dotted route turns solid, then the rider joins the car and the
  // trip's own route (which is the same line) takes over.
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
  }, []);
  const acceptPreview = useCallback(() => {
    if (!ride || !previewing || !previewData || committing) return;
    setCommitting(true);
    const { suggestion } = previewing;
    const fare = previewData.farePesewas;
    commitTimer.current = setTimeout(() => {
      runAddRider(ride.id, suggestion, fare, positionRef.current);
      skippedRef.current.add(suggestion.requestRideId);
      setPreviewing(null);
      setCommitting(false);
    }, 450);
  }, [ride, previewing, previewData, committing]);

  // ─── Layout ──────────────────────────────────────────────────────────────
  const [cardHeight, setCardHeight] = useState(300);
  const [topHeight, setTopHeight] = useState(insets.top + 64);
  const [stopsOpen, setStopsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);


  const now = useNow(next?.kind === "PICKUP" && next.passengerStatus === "ARRIVED");

  // After each step, a short note: "Ama is in the car · next: pick up Kofi".
  const { showToast, toast } = useToast();
  const onStep = useCallback(
    (stop: TripStop, step: "arrived" | "pickup" | "dropoff") => {
      if (step === "arrived") {
        showToast(`${riderName(stop)} has been told you're here`);
        return;
      }
      const after = plan.upcoming.filter((s) => s.key !== stop.key && !(step === "pickup" && s.key === `${stop.passengerId}:PICKUP`));
      showToast(stepToast(stop, after[0]));
    },
    [plan.upcoming, showToast],
  );

  // The seat dots explain themselves the first time a driver sees them.
  const [seatLegend, setSeatLegend] = useState(false);
  useEffect(() => {
    if (ride?.type !== "SHARED") return;
    let cancelled = false;
    void SecureStore.getItemAsync(SEAT_LEGEND_KEY)
      .then((seen) => {
        if (cancelled || seen) return;
        setSeatLegend(true);
        void SecureStore.setItemAsync(SEAT_LEGEND_KEY, "1").catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ride?.type]);
  useEffect(() => {
    if (!seatLegend) return;
    const t = setTimeout(() => setSeatLegend(false), 10_000);
    return () => clearTimeout(t);
  }, [seatLegend]);

  const goHome = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
    goToHomeTab(router);
  }, [router, queryClient]);

  // iOS swipe-back is off while a trip is running: the slide-to-confirm knob
  // starts near the left edge, and the system gesture used to grab the drag
  // and slide the whole screen away. Back stays on the ← button (which
  // minimises the trip, as before). On the summary and "trip ended"
  // screens it works normally again.
  const tripRunning = Boolean((ride || (claim && claim.state !== "refused")) && !(done && done.rideId === rideId));
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !tripRunning, fullScreenGestureEnabled: false });
  }, [navigation, tripRunning]);

  // Accept refused ("Ride taken by another driver"): say why, then back to
  // Home by itself — the driver is never left on a dead screen.
  const refused = !serverRide && claim?.state === "refused";
  useEffect(() => {
    if (!refused) return;
    const t = setTimeout(() => {
      clearClaim();
      goHome();
    }, 2_500);
    return () => clearTimeout(t);
  }, [refused, goHome]);

  // Opened straight into a trip (a notification, a relaunch): wait for the
  // session to be restored rather than sending the driver to sign in.
  if (sessionLoading) return <SessionRestoringScreen />;
  if (!isAuthenticated || !user) return <Redirect href="/auth/phone" />;

  // ─── Done ────────────────────────────────────────────────────────────────
  if (done && done.rideId === rideId) {
    return (
      <Screen>
        <View style={styles.center}>
          <Illustration name="tripComplete" size={150} pop />
          <Text variant="h1" style={styles.centerText}>
            Trip complete
          </Text>
          <Card dark style={styles.earnCard}>
            <Text variant="label" color="glow">
              {done.cash ? "CASH COLLECTED" : "YOUR EARNINGS (85%)"}
            </Text>
            <CountUpCedis pesewas={done.cash ? done.totalPesewas : done.driverSharePesewas} />
            {done.cash ? (
              <Text variant="bodySmall" style={styles.earnSub}>
                Your share {formatCedis(done.driverSharePesewas)} · platform fee {formatCedis(done.commissionPesewas)}
              </Text>
            ) : null}
          </Card>
          <RateRidersPanel rideId={done.rideId} />
          <Button label="Back to Home" size="lg" onPress={goHome} />
        </View>
      </Screen>
    );
  }

  // ─── Accept refused (another driver was first, the rider cancelled) ─────
  if (!serverRide && claim?.state === "refused") {
    return (
      <Screen>
        <View style={styles.center}>
          <Illustration name="searchEmpty" size={140} />
          <Text variant="h2" style={styles.centerText} accessibilityRole="alert">
            {claim.message ?? "Not accepted"}
          </Text>
          <Text variant="bodySmall" color="muted" style={styles.centerText}>
            Taking you back to Home…
          </Text>
          <Button
            label="Back to Home"
            size="lg"
            onPress={() => {
              clearClaim();
              goHome();
            }}
          />
        </View>
      </Screen>
    );
  }

  if (!ride) {
    if (isLoading) {
      return (
        <Screen>
          <LoadingState message="Loading your trip…" />
        </Screen>
      );
    }
    return (
      <Screen>
        <View style={styles.center}>
          <Illustration name="searchEmpty" size={140} />
          <Text variant="h2" style={styles.centerText}>
            This trip has ended
          </Text>
          <Text variant="bodySmall" color="muted" style={styles.centerText}>
            The rider cancelled, or the trip was closed. You&apos;re free to take new requests.
          </Text>
          <Button label="Back to Home" onPress={goHome} size="lg" />
        </View>
      </Screen>
    );
  }

  // ─── On the trip ─────────────────────────────────────────────────────────
  const tripFare = passengers
    .filter((p) => p.status !== "CANCELLED")
    .reduce((sum, p) => sum + (p.lockedFare ?? 0), 0);
  const seats = seatStates(passengers);

  return (
    <View style={styles.root}>
      <TripMap
        driver={position}
        stops={mapStops}
        path={path}
        insets={{ top: topHeight, bottom: cardHeight }}
        attribution={live.attribution ?? (storedRoutes.length > 0 ? routeAttribution(storedRoutes[0]!.provider) : null)}
        preview={previewOverlay}
      />


      {seatLegend ? (
        <Pressable
          onPress={() => setSeatLegend(false)}
          style={[styles.legend, { top: topHeight + spacing.xs }]}
          accessibilityRole="button"
          accessibilityLabel="Seat dots: filled means in the car, light means to pick up, empty means a free seat. Dismiss."
        >
          <Text variant="caption" style={styles.legendText}>
            ● in the car · ◐ to pick up · ○ free seat
          </Text>
        </Pressable>
      ) : null}

      <TopBar onBack={goHome} onLayout={(e) => setTopHeight(e.nativeEvent.layout.height)} syncing={actions.retrying}>
        {ride.type === "SHARED" ? (
          <View style={styles.seatChip} accessible accessibilityLabel={`${activeSeats} of ${CAR_SEATS} seats taken`}>
            <SeatDots seats={seats} />
            <Text variant="caption" style={styles.chipText}>
              {activeSeats} of {CAR_SEATS}
            </Text>
          </View>
        ) : (
          <Chip label="Ride alone" />
        )}
        {tripFare > 0 ? <Chip label={formatCedis(tripFare)} /> : null}
        {farFromCampus ? <Chip label="Far from campus" warn /> : null}
        {location.isFake && location.fake && next ? (
          <Pressable
            onPress={() =>
              location.fake!.driving
                ? location.fake!.driveAlong(null)
                : location.fake!.driveAlong(position ? pathToNext : null)
            }
            accessibilityRole="button"
            accessibilityLabel={location.fake.driving ? "Stop the fake drive" : "Fake-drive to the next stop"}
          >
            <Chip label={location.fake.driving ? "■ Stop" : "▶ Drive (fake)"} warn />
          </Pressable>
        ) : null}
      </TopBar>

      <View
        style={[styles.card, { paddingBottom: insets.bottom + spacing.lg }]}
        onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
      >
        {refusal ? (
          <View style={styles.refusal} accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle" size={18} color={colors.danger} />
            <Text variant="bodySmall" style={styles.refusalText}>
              {refusal}
            </Text>
            <Pressable onPress={() => setRefusal(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
              <Text variant="bodySmall" style={styles.refusalOk}>OK</Text>
            </Pressable>
          </View>
        ) : null}

        {previewing && (!autoOffer || previewData) ? (
          // The new rider, plainly: where from, where to, and Add. Never
          // taller than it needs to be, so the NEXT STOP card and its slider
          // below always stay in view.
          <View style={styles.previewCard} accessibilityLiveRegion="polite">
            {autoOffer && offerClock ? (
              <CountdownBar deadline={offerClock.deadline} totalMs={offerClock.deadline - offerClock.shownAt} />
            ) : null}
            <Pressable
              onPress={() => {
                tapFeedback();
                passOnOffer("DECLINED");
              }}
              disabled={committing}
              accessibilityRole="button"
              accessibilityLabel={autoOffer ? "Decline this rider" : "Close"}
              hitSlop={10}
              style={styles.previewClose}
            >
              <Ionicons name="close" size={20} color={colors.ink[500]} />
            </Pressable>
            <View
              style={styles.previewRoute}
              accessible
              accessibilityLabel={`New rider, from ${previewing.suggestion.pickupPlaceName ?? previewing.suggestion.pickupZoneName} to ${previewing.suggestion.dropoffPlaceName ?? previewing.suggestion.dropoffZoneName}`}
            >
              <View style={styles.previewMarkers}>
                <View style={styles.previewPickupDot} />
                <View style={styles.previewConnector} />
                <View style={styles.previewDropoffSquare} />
              </View>
              <View style={styles.previewPlaces}>
                <Text style={styles.previewPlace}>
                  {previewing.suggestion.pickupPlaceName ?? previewing.suggestion.pickupZoneName}
                </Text>
                <Text style={styles.previewPlace}>
                  {previewing.suggestion.dropoffPlaceName ?? previewing.suggestion.dropoffZoneName}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => {
                tapFeedback();
                acceptPreview();
              }}
              disabled={!previewData || committing}
              accessibilityRole="button"
              accessibilityLabel="Add this rider"
              style={({ pressed }) => [
                styles.previewAdd,
                (pressed || committing) && styles.previewAddPressed,
                !previewData && styles.previewAddWaiting,
              ]}
            >
              <Text style={styles.previewAddText}>{previewData ? "Add" : "Checking the route…"}</Text>
            </Pressable>
          </View>
        ) : null}

        {next ? (
          <NextStopCard
            ride={ride}
            stop={next}
            etaMinutes={etaMinutes}
            atStop={atNextStop}
            now={now}
            onStep={onStep}
          />
        ) : (
          <Text variant="bodySmall" color="muted">Finishing up…</Text>
        )}

        <View style={styles.footerRow}>
          {plan.upcoming.length > 1 ? (
            <Pressable
              onPress={() => setStopsOpen(true)}
              style={styles.moreStops}
              accessibilityRole="button"
              accessibilityLabel={`${plan.upcoming.length - 1} more stops. Show all stops.`}
            >
              <Ionicons name="list" size={16} color={colors.ink[700]} />
              <Text variant="bodySmall" style={styles.moreStopsText}>
                {plan.upcoming.length - 1} more stop{plan.upcoming.length - 1 === 1 ? "" : "s"}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
          {ride.type === "SHARED" ? (
            <View style={styles.seatsAndAdd}>
              {canAddRiders && freeSeats > 0 ? (
                <Pressable
                  onPress={() => setAddOpen(true)}
                  style={styles.addChip}
                  accessibilityRole="button"
                  accessibilityLabel={`Add a rider. ${suggestions.length} waiting nearby.`}
                >
                  <Ionicons name="person-add-outline" size={14} color={colors.primary[600]} />
                  <Text variant="caption" style={styles.addChipText}>
                    Add rider{suggestions.length > 0 ? ` (${suggestions.length})` : ""}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      <StopListSheet
        visible={stopsOpen}
        onClose={() => setStopsOpen(false)}
        stops={plan.upcoming}
        passengers={passengers}
        nextEtaMinutes={etaMinutes}
      />
      {toast}
      <AddRiderSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        suggestions={suggestions}
        freeSeats={freeSeats}
        onAdd={(s) => {
          setCommitting(false);
          setPreviewing({ suggestion: s, manual: true });
          setAddOpen(false);
        }}
      />
    </View>
  );
}

// ─── Next stop ───────────────────────────────────────────────────────────────

function NextStopCard({
  ride,
  stop,
  etaMinutes,
  atStop,
  now,
  onStep,
}: {
  ride: RideWithZones;
  stop: TripStop;
  etaMinutes: number | null;
  atStop: boolean;
  now: number;
  onStep: (stop: TripStop, step: "arrived" | "pickup" | "dropoff") => void;
}) {
  const name = riderName(stop);
  const where =
    atStop || (stop.kind === "PICKUP" && stop.passengerStatus === "ARRIVED")
      ? "you're here"
      : etaMinutes !== null
        ? `${etaMinutes} min away`
        : null;
  const act = (action: Parameters<typeof runPassengerAction>[2]) => runPassengerAction(ride.id, stop.passengerId, action);

  const arrived = stop.kind === "PICKUP" && stop.passengerStatus === "ARRIVED";
  const arrivedAt = stop.arrivedAt ? Date.parse(stop.arrivedAt) : null;
  const noShowAt = noShowAvailableAt(stop.arrivedAt);
  const canNoShow = noShowAt !== null && now >= noShowAt;
  const cash = ride.paymentMethod === "CASH";

  return (
    <View style={styles.nextStop}>
      <View style={styles.nextHeader}>
        <Text variant="label" color="muted">
          NEXT STOP · {stop.kind === "PICKUP" ? "PICKUP" : "DROP-OFF"}
        </Text>
      </View>
      {/* What to do now, in plain words. */}
      <Text variant="h3" numberOfLines={2} accessibilityRole="header">
        {nextStopInstruction(stop, { cash, formatFare: formatCedis })}
      </Text>
      {where ? (
        <Text variant="bodySmall" color="muted" numberOfLines={1}>
          {where === "you're here" ? "You're here" : where}
        </Text>
      ) : null}

      {stop.note ? (
        <View style={styles.noteRow} accessible accessibilityLabel={`Note from ${name}: ${stop.note}`}>
          <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.ink[500]} />
          <Text variant="bodySmall" style={styles.noteText} numberOfLines={3}>
            “{stop.note}”
          </Text>
        </View>
      ) : null}

      {arrived && arrivedAt !== null ? (
        <View style={styles.waitRow}>
          <Ionicons name="checkmark-circle" size={18} color={colors.primary[500]} />
          <Text variant="bodySmall" style={styles.waitText}>
            {name} knows you&apos;re here
          </Text>
          <Text variant="bodySmall" color="muted">
            Waiting {formatWait(now - arrivedAt)}
          </Text>
        </View>
      ) : null}

      {stop.kind === "DROPOFF" && stop.farePesewas !== null ? (
        <View style={styles.cashBox} accessible accessibilityLabel={`${cash ? "Collect cash" : "Fare"}: ${formatCedis(stop.farePesewas)}`}>
          <Text variant="bodySmall" style={styles.cashLabel}>
            {cash ? "Collect cash" : "Fare (paid by MoMo)"}
          </Text>
          <Text variant="h1" style={styles.cashAmount}>
            {formatCedis(stop.farePesewas)}
          </Text>
        </View>
      ) : null}

      {/* Navigate + Call. Each takes half the width and may shrink; nothing runs off the edge. */}
      <View style={styles.actionRow}>
        <View style={styles.actionCell}>
          <Button
            label="Navigate"
            variant="secondary"
            onPress={() => void openDirections({ latitude: stop.point.latitude, longitude: stop.point.longitude, label: stop.label })}
          />
        </View>
        {stop.riderPhone ? (
          <View style={styles.actionCell}>
            <Button label={`Call ${name}`} variant="secondary" onPress={() => void callPhone(stop.riderPhone, name)} />
          </View>
        ) : null}
      </View>

      {stop.kind === "PICKUP" ? (
        <>
          {/* Keyed by stop: every stop gets a fresh slider, so it can never
              stay stuck at the end when two stops share a label. */}
          <SlideToConfirm
            key={stop.key}
            label={`${name} picked up`}
            onConfirm={() => {
              if (stop.passengerStatus === "WAITING") act("arrived");
              act("pickup");
              onStep(stop, "pickup");
            }}
          />
          <View style={styles.smallLinks}>
            {stop.passengerStatus === "WAITING" ? (
              <>
                <SmallLink
                  label="I'm here"
                  onPress={() => {
                    act("arrived");
                    onStep(stop, "arrived");
                  }}
                  hint="Tell the rider you've arrived"
                />
                <SmallLink
                  label="Cancel pickup"
                  danger
                  onPress={() =>
                    Alert.alert(`Remove ${name}?`, "They'll be told their pickup was cancelled.", [
                      { text: "Keep", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => act("cancel") },
                    ])
                  }
                />
              </>
            ) : (
              <SmallLink
                label={canNoShow || noShowAt === null ? "Rider didn't show" : `Rider didn't show (at ${formatWait(NO_SHOW_AFTER_MS)})`}
                danger
                disabled={!canNoShow}
                onPress={() =>
                  Alert.alert(`${name} didn't show?`, "Their pickup is cancelled and they're told why.", [
                    { text: "Keep waiting", style: "cancel" },
                    { text: "Cancel pickup", style: "destructive", onPress: () => act("no-show") },
                  ])
                }
              />
            )}
          </View>
        </>
      ) : (
        <SlideToConfirm
          key={stop.key}
          label={cash ? `Cash collected from ${name}` : `${name} dropped off`}
          tone="dark"
          onConfirm={() => {
            act("dropoff");
            onStep(stop, "dropoff");
          }}
        />
      )}
    </View>
  );
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function TopBar({
  onBack,
  onLayout,
  syncing,
  children,
}: {
  onBack: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
  syncing: boolean;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]} onLayout={onLayout} pointerEvents="box-none">
      {/* Minimise: the trip carries on; the banner on every tab brings the driver back. */}
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go to Home. Your trip continues." hitSlop={6} style={styles.roundButton}>
        <Ionicons name="arrow-back" size={22} color={colors.ink[900]} />
      </Pressable>
      <View style={styles.chips}>{children}</View>
      {syncing ? (
        <View style={styles.syncing} accessibilityLiveRegion="polite" accessibilityLabel="Sending. Waiting for a connection.">
          <Ionicons name="cloud-upload-outline" size={16} color={colors.ink[600]} />
          <Text variant="caption" color="muted">Sending…</Text>
        </View>
      ) : null}
    </View>
  );
}

function Chip({ label, warn }: { label: string; warn?: boolean }) {
  return (
    <View style={[styles.chip, warn && styles.chipWarn]}>
      <Text variant="caption" style={[styles.chipText, warn && styles.chipWarnText]}>
        {label}
      </Text>
    </View>
  );
}

function SmallLink({
  label,
  onPress,
  danger,
  disabled,
  hint,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={styles.smallLink}
    >
      <Text
        variant="bodySmall"
        style={[styles.smallLinkText, danger && styles.smallLinkDanger, disabled && styles.smallLinkDisabled]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function CountUpCedis({ pesewas }: { pesewas: number }) {
  const shown = useCountUp(pesewas);
  return (
    <Text variant="h1" color="inverse" style={styles.earnAmount}>
      {formatCedis(shown)}
    </Text>
  );
}

const styles = StyleSheet.create({
  noteRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
  },
  noteText: { flex: 1, color: colors.ink[700], fontStyle: "italic" },
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, paddingHorizontal: spacing.xl },
  centerText: { textAlign: "center" },
  earnCard: { alignItems: "center", paddingVertical: spacing.xl, gap: spacing.sm, width: "100%" },
  earnAmount: { fontWeight: typography.weight.extrabold },
  earnSub: { color: "rgba(255,255,255,0.7)", textAlign: "center" },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.md,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, flexShrink: 1 },
  chip: {
    backgroundColor: colors.white,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    ...shadows.sm,
  },
  chipText: { fontWeight: typography.weight.bold, color: colors.ink[900] },
  seatChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.white,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    ...shadows.sm,
  },
  chipWarn: { backgroundColor: colors.warningSurface },
  chipWarnText: { color: colors.warning },
  syncing: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.white,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  card: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    gap: spacing.md,
    ...shadows.lg,
  },
  legend: {
    position: "absolute",
    alignSelf: "center",
    backgroundColor: colors.white,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    zIndex: 4,
    ...shadows.md,
  },
  legendText: { color: colors.ink[700], fontWeight: typography.weight.semibold },
  previewCard: {
    gap: spacing.md,
    backgroundColor: colors.primary[50],
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md + 4,
    paddingBottom: spacing.md,
    overflow: "hidden",
  },
  previewClose: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    width: 32,
    height: 32,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.white,
    zIndex: 1,
  },
  previewRoute: { flexDirection: "row", gap: spacing.md, paddingRight: 36 },
  previewMarkers: { alignItems: "center", paddingTop: 7, width: 12 },
  previewPickupDot: { width: 11, height: 11, borderRadius: radii.full, backgroundColor: colors.primary[500] },
  previewConnector: { width: 2, flex: 1, minHeight: 14, backgroundColor: colors.primary[200], marginVertical: 3 },
  previewDropoffSquare: { width: 11, height: 11, borderRadius: 2, backgroundColor: colors.ink[900], marginBottom: 7 },
  previewPlaces: { flex: 1, gap: spacing.sm },
  previewPlace: { fontSize: 18, lineHeight: 23, fontWeight: typography.weight.bold, color: colors.ink[900] },
  previewAdd: {
    height: 52,
    borderRadius: radii.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary[500],
  },
  previewAddPressed: { backgroundColor: colors.primary[600] },
  previewAddWaiting: { backgroundColor: colors.primary[300] },
  previewAddText: { color: colors.white, fontSize: 18, fontWeight: typography.weight.extrabold },
  refusal: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.errorSurface,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  refusalText: { flex: 1, color: colors.danger },
  refusalOk: { color: colors.danger, fontWeight: typography.weight.bold },
  nextStop: { gap: spacing.sm },
  nextHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  waitRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" },
  waitText: { fontWeight: typography.weight.semibold, color: colors.primary[600], flexShrink: 1 },
  cashBox: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  cashLabel: { color: colors.ink[600], fontWeight: typography.weight.semibold },
  cashAmount: { fontWeight: typography.weight.extrabold, fontSize: 40, lineHeight: 46 },
  actionRow: { flexDirection: "row", gap: spacing.sm },
  actionCell: { flex: 1, minWidth: 0 },
  smallLinks: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.sm },
  smallLink: { paddingVertical: spacing.xs, minHeight: 32, justifyContent: "center" },
  smallLinkText: { color: colors.ink[700], fontWeight: typography.weight.semibold },
  smallLinkDanger: { color: colors.danger },
  smallLinkDisabled: { color: colors.ink[300] },
  footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  moreStops: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.xs, minHeight: 36 },
  moreStopsText: { fontWeight: typography.weight.semibold, color: colors.ink[700] },
  seatsAndAdd: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  addChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.primary[200],
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    minHeight: 32,
  },
  addChipText: { color: colors.primary[600], fontWeight: typography.weight.bold },
});
