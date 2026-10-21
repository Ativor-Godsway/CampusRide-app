import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Redirect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
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
  noShowAvailableAt,
  riderName,
  stepToast,
  isOutsideServiceArea,
  planTripStops,
  formatDistance,
  getSharedFarePerRider,
  routeAttribution,
  splitFare,
  todayEarnings,
  tripPath,
  type LatLng,
  type TripStop,
  type TripZone,
} from "@rida/shared";
import {
  BottomSheet,
  Button,
  IconButton,
  ListRow,
  LoadingState,
  Notice,
  Screen,
  SessionRestoringScreen,
  SlideToConfirm,
  StatusChip,
  Text,
  callPhone,
  colors,
  errorStatus,
  getAddRiderPreview,
  getDriverRideHistory,
  getFillSuggestions,
  serverReason,
  getRideSocket,
  goHome as goToHomeTab,
  openDirections,
  radii,
  shadows,
  spacing,
  textPhone,
  useAuth,
  useToast,
  useLiveRoute,
  type FillSuggestion,
  type PassengerInCar,
  type RideWithZones,
} from "@rida/mobile-shared";
import { driverActiveRideQueryKey, useDriverActiveTrip } from "../../lib/activeTrip";
import { useDriverLocation, useLocationDemand } from "../../lib/location";
import { useZoneRoutes, useZones } from "../../lib/zones";
import { alertNewOffer } from "../../lib/offerAlert";
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
import { TripMap } from "../../components/trip/TripMap";
import { StopListSheet } from "../../components/trip/StopListSheet";
import { AddRiderSheet } from "../../components/trip/AddRiderSheet";
import { AddRiderTakeover } from "../../components/trip/AddRiderTakeover";
import { TripCompleteView, TripEndedView } from "../../components/trip/TripEndScreens";
import { useDriverPresence } from "../../lib/presence";

/** The trip screen checks its trip more often than the rest of the app (a rider may cancel). */
const TRIP_POLL_MS = 5_000;

interface DoneSummary {
  rideId: string;
  /** "Maison Française → Night Market" (one rider), or "3 riders · Shared". */
  route: string;
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
    const only = carried.length === 1 ? carried[0]! : null;
    setDone({
      rideId: ride.id,
      route: only
        ? `${only.pickupLabel ?? only.pickupZoneName} → ${only.dropoffLabel ?? only.dropoffZoneName}`
        : `${carried.length} riders · Shared`,
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
  const [offerClock, setOfferClock] = useState<{
    rideId: string;
    shownAt: number;
    deadline: number;
    /** "Add" tapped: the countdown stops here. */
    heldAt?: number;
  } | null>(null);
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
  // The proposed route, ahead of the driver only (the add-rider takeover's map).
  const previewPath = useMemo(
    () => (position && proposedFull.length >= 2 ? trimPathToPosition(proposedFull, position) : proposedFull),
    [proposedFull, position],
  );

  // "Add": a moment's spinner on the takeover (its countdown stopped), then
  // the rider joins the car and the trip's own route takes over.
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
  }, []);
  const acceptPreview = useCallback(() => {
    if (!ride || !previewing || !previewData || committing) return;
    setCommitting(true);
    setOfferClock((c) => (c ? { ...c, heldAt: Date.now() } : c));
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
  const [menuOpen, setMenuOpen] = useState(false);


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

  const goHome = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
    goToHomeTab(router);
  }, [router, queryClient]);

  // Today so far, for the trip-complete card: the same history as Home's
  // "Today" pill and the Earnings tab, fetched again once the trip is done.
  const finished = Boolean(done && done.rideId === rideId);
  const history = useQuery({
    queryKey: ["driverRideHistory"],
    queryFn: getDriverRideHistory,
    enabled: finished,
  });
  const today = history.data ? todayEarnings(history.data.rides) : null;

  // "Find next trip": Home, online (going online if the driver had gone offline).
  const presence = useDriverPresence();
  const findNextTrip = useCallback(() => {
    if (!presence.isOnline) presence.toggle();
    goHome();
  }, [presence, goHome]);

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
  if (!isAuthenticated || !user) return <Redirect href="/auth/welcome" />;

  // ─── Done ────────────────────────────────────────────────────────────────
  if (done && done.rideId === rideId) {
    return (
      <TripCompleteView
        rideId={done.rideId}
        route={done.route}
        cash={done.cash}
        totalPesewas={done.totalPesewas}
        driverSharePesewas={done.driverSharePesewas}
        commissionPesewas={done.commissionPesewas}
        today={today}
        onFindNext={findNextTrip}
      />
    );
  }

  // ─── Accept refused (another driver was first, the rider cancelled) ─────
  if (!serverRide && claim?.state === "refused") {
    return (
      <TripEndedView
        title={claim.message ?? "Not accepted"}
        message="Taking you back to Home…"
        onHome={() => {
          clearClaim();
          goHome();
        }}
      />
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
      <TripEndedView
        title="This trip has ended"
        message="The rider cancelled, or the trip was closed. You're free to take new requests."
        onHome={goHome}
      />
    );
  }

  // ─── On the trip ─────────────────────────────────────────────────────────
  const tripFare = passengers
    .filter((p) => p.status !== "CANCELLED")
    .reduce((sum, p) => sum + (p.lockedFare ?? 0), 0);
  const price = tripFare > 0 ? ` · ${formatCedis(tripFare)}` : "";
  const pill =
    ride.type === "SHARED"
      ? `Shared · ${activeSeats}/${CAR_SEATS} seats${price}`
      : `Ride alone${price}`;

  // The next pickup's own actions, for the ⋯ menu.
  const nextPickup = next?.kind === "PICKUP" ? next : null;
  const nextName = next ? riderName(next) : "";
  const noShowAt = noShowAvailableAt(nextPickup?.arrivedAt);
  const canNoShow = noShowAt !== null && now >= noShowAt;
  const actOnNext = (action: Parameters<typeof runPassengerAction>[2]) => {
    if (next) runPassengerAction(ride.id, next.passengerId, action);
  };
  const closeMenuThen = (then: () => void) => {
    setMenuOpen(false);
    then();
  };
  const confirmCancelPickup = () =>
    Alert.alert(`Remove ${nextName}?`, "They'll be told their pickup was cancelled.", [
      { text: "Keep", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => actOnNext("cancel") },
    ]);
  const confirmNoShow = () =>
    Alert.alert(`${nextName} didn't show?`, "Their pickup is cancelled and they're told why.", [
      { text: "Keep waiting", style: "cancel" },
      { text: "Cancel pickup", style: "destructive", onPress: () => actOnNext("no-show") },
    ]);
  const tellHere = () => {
    if (!next) return;
    actOnNext("arrived");
    onStep(next, "arrived");
  };

  return (
    <View style={styles.root}>
      <TripMap
        driver={position}
        stops={mapStops}
        path={path}
        insets={{ top: topHeight, bottom: cardHeight }}
        attribution={live.attribution ?? (storedRoutes.length > 0 ? routeAttribution(storedRoutes[0]!.provider) : null)}
      />

      <TopBar
        label={pill}
        onBack={goHome}
        onMore={() => setMenuOpen(true)}
        onLayout={(e) => setTopHeight(e.nativeEvent.layout.height)}
        syncing={actions.retrying}
        farFromCampus={farFromCampus}
      />

      <View
        style={[styles.card, { paddingBottom: insets.bottom + spacing[4] }]}
        onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
      >
        <View style={styles.handle} />
        {refusal ? (
          <Pressable
            onPress={() => setRefusal(null)}
            accessibilityRole="button"
            accessibilityHint="Dismiss"
          >
            <Notice tone="error" icon="alert-circle-outline" message={refusal} />
          </Pressable>
        ) : null}

        {next ? (
          <NextStopCard
            ride={ride}
            stop={next}
            stopNumber={plan.doneCount + 1}
            stopCount={plan.totalCount}
            etaMinutes={etaMinutes}
            distanceMeters={position ? haversineDistanceMeters(position, next.point) : null}
            atStop={atNextStop}
            now={now}
            canNoShow={canNoShow}
            onStep={onStep}
            onTellHere={tellHere}
            onNoShow={confirmNoShow}
            onStops={() => setStopsOpen(true)}
          />
        ) : (
          <Text variant="subhead" color="secondary">
            Finishing up…
          </Text>
        )}
      </View>

      {/* The ⋯ menu: everything that isn't the one thing to do now. */}
      <BottomSheet modal visible={menuOpen} onDismiss={() => setMenuOpen(false)} accessibilityLabel="Trip actions">
        <View>
          {nextPickup?.passengerStatus === "WAITING" ? (
            <ListRow
              title="I'm here"
              subtitle={`Tell ${nextName} you've arrived`}
              leading={<ListRow.Icon name="flag-outline" />}
              onPress={() => closeMenuThen(tellHere)}
            />
          ) : null}
          {canAddRiders && freeSeats > 0 ? (
            <ListRow
              divider={nextPickup?.passengerStatus === "WAITING"}
              title="Add a rider"
              subtitle={`${freeSeats} free seat${freeSeats === 1 ? "" : "s"} · ${suggestions.length} waiting near you`}
              leading={<ListRow.Icon name="person-add-outline" />}
              onPress={() => closeMenuThen(() => setAddOpen(true))}
            />
          ) : null}
          <ListRow
            divider={nextPickup?.passengerStatus === "WAITING" || (canAddRiders && freeSeats > 0)}
            title="Stops"
            subtitle={`${plan.upcoming.length} to go`}
            leading={<ListRow.Icon name="list-outline" />}
            onPress={() => closeMenuThen(() => setStopsOpen(true))}
          />
          {nextPickup?.passengerStatus === "WAITING" ? (
            <ListRow
              divider
              tone="danger"
              title="Cancel pickup"
              subtitle={`${nextName} is told their pickup was cancelled`}
              leading={<ListRow.Icon name="close-circle-outline" tone="danger" />}
              showChevron={false}
              onPress={() => closeMenuThen(confirmCancelPickup)}
            />
          ) : null}
          {nextPickup?.passengerStatus === "ARRIVED" ? (
            <ListRow
              divider
              tone="danger"
              title="Rider didn't show"
              subtitle={canNoShow ? `Cancel ${nextName}'s pickup` : `After ${formatWait(NO_SHOW_AFTER_MS)} of waiting`}
              leading={<ListRow.Icon name="person-remove-outline" tone="danger" />}
              showChevron={false}
              disabled={!canNoShow}
              onPress={() => closeMenuThen(confirmNoShow)}
            />
          ) : null}
          {location.isFake && location.fake && next ? (
            <ListRow
              divider
              title={location.fake.driving ? "Stop the fake drive" : "Drive (fake)"}
              subtitle="Developer: move the fake position to the next stop"
              leading={<ListRow.Icon name={location.fake.driving ? "stop-outline" : "play-outline"} />}
              showChevron={false}
              onPress={() =>
                closeMenuThen(() =>
                  location.fake!.driving
                    ? location.fake!.driveAlong(null)
                    : location.fake!.driveAlong(position ? pathToNext : null),
                )
              }
            />
          ) : null}
        </View>
      </BottomSheet>

      <StopListSheet
        visible={stopsOpen}
        onClose={() => setStopsOpen(false)}
        stops={plan.upcoming}
        passengers={passengers}
        nextEtaMinutes={etaMinutes}
      />
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

      {previewing && (!autoOffer || previewData) ? (
        <AddRiderTakeover
          key={previewing.suggestion.requestRideId}
          suggestion={previewing.suggestion}
          preview={previewData}
          car={position}
          zones={zones}
          path={previewPath}
          countdown={
            autoOffer && offerClock
              ? {
                  deadline: offerClock.deadline,
                  totalMs: offerClock.deadline - offerClock.shownAt,
                  frozenAt: committing ? offerClock.heldAt : undefined,
                }
              : null
          }
          sharedFarePesewas={getSharedFarePerRider(1)}
          freeSeats={freeSeats}
          committing={committing}
          onAdd={acceptPreview}
          onDecline={() => passOnOffer("DECLINED")}
        />
      ) : null}

      {/* Last, so it sits on top of everything, under the status bar. */}
      {toast}
    </View>
  );
}

// ─── Next stop ───────────────────────────────────────────────────────────────

/**
 * The sheet (docs/mockups/11-driver-trip.png): what's next and where, the
 * rider's note, round Navigate · Call · Message · Stops, and ONE slide at the
 * bottom — "Slide when Kwame is in" at a pickup, the dark cash slide at a
 * drop-off with the amount large above it. Near the pickup, "I'm here ·
 * tell Kwame"; once there, how long the driver has been waiting.
 */
function NextStopCard({
  ride,
  stop,
  stopNumber,
  stopCount,
  etaMinutes,
  distanceMeters,
  atStop,
  now,
  canNoShow,
  onStep,
  onTellHere,
  onNoShow,
  onStops,
}: {
  ride: RideWithZones;
  stop: TripStop;
  stopNumber: number;
  stopCount: number;
  etaMinutes: number | null;
  /** Straight-line, from the driver to the stop; null without a position. */
  distanceMeters: number | null;
  atStop: boolean;
  now: number;
  /** "Rider didn't show" is open (NO_SHOW_AFTER_MS after arriving). */
  canNoShow: boolean;
  onStep: (stop: TripStop, step: "arrived" | "pickup" | "dropoff") => void;
  onTellHere: () => void;
  onNoShow: () => void;
  onStops: () => void;
}) {
  const name = riderName(stop);
  const act = (action: Parameters<typeof runPassengerAction>[2]) => runPassengerAction(ride.id, stop.passengerId, action);
  const pickup = stop.kind === "PICKUP";
  const arrived = pickup && stop.passengerStatus === "ARRIVED";
  const arrivedAt = stop.arrivedAt ? Date.parse(stop.arrivedAt) : null;
  const cash = ride.paymentMethod === "CASH";
  const fare = stop.farePesewas !== null ? formatCedis(stop.farePesewas) : null;

  const where = [
    stop.label,
    ...(atStop || arrived
      ? ["you're here"]
      : [
          etaMinutes !== null ? `${etaMinutes} min` : null,
          distanceMeters !== null ? formatDistance(distanceMeters) : null,
        ]),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.nextStop}>
      <View style={styles.nextHeader}>
        <Text variant="eyebrow" color="secondary">
          Next stop · {pickup ? "Pickup" : "Drop-off"}
        </Text>
        <Text variant="subhead" color="secondary" tabular>
          Stop {stopNumber} of {stopCount}
        </Text>
      </View>
      <View style={styles.nextTitle}>
        {/* What to do now, in plain words. */}
        <Text style={styles.instruction} numberOfLines={2} accessibilityRole="header">
          {pickup ? "Pick up" : "Drop off"} {name}
        </Text>
        <Text variant="subhead" color="secondary" numberOfLines={2}>
          {where}
        </Text>
      </View>

      {stop.note ? (
        <View style={styles.noteRow} accessible accessibilityLabel={`Note from ${name}: ${stop.note}`}>
          <Ionicons name="chatbox-outline" size={18} color={colors.ink2} />
          <Text variant="body" style={styles.noteText} numberOfLines={3}>
            “{stop.note}”
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <View style={styles.action}>
          <IconButton
            variant="brand"
            icon="navigate-outline"
            label="Navigate"
            accessibilityLabel={`Navigate to ${stop.label}`}
            onPress={() => void openDirections({ latitude: stop.point.latitude, longitude: stop.point.longitude, label: stop.label })}
          />
        </View>
        <View style={styles.action}>
          <IconButton
            icon="call-outline"
            label="Call"
            accessibilityLabel={`Call ${name}`}
            disabled={!stop.riderPhone}
            onPress={() => void callPhone(stop.riderPhone, name)}
          />
        </View>
        <View style={styles.action}>
          <IconButton
            icon="chatbox-outline"
            label="Message"
            accessibilityLabel={`Text ${name}`}
            disabled={!stop.riderPhone}
            onPress={() => void textPhone(stop.riderPhone, name)}
          />
        </View>
        <View style={styles.action}>
          <IconButton icon="list-outline" label="Stops" accessibilityLabel="Show all stops" onPress={onStops} />
        </View>
      </View>

      {pickup && stop.passengerStatus === "WAITING" && atStop ? (
        <Button
          label={`I'm here · tell ${name}`}
          variant="secondary"
          size="md"
          onPress={onTellHere}
          accessibilityHint="Tell the rider you've arrived"
        />
      ) : null}

      {arrived && arrivedAt !== null ? (
        <View style={styles.waitRow}>
          <View style={styles.waitChip} accessible accessibilityLabel={`Waiting for ${formatWait(now - arrivedAt)}`}>
            <Ionicons name="time-outline" size={16} color={colors.ink2} />
            <Text variant="subhead" style={styles.waitText} tabular>
              Waiting · {formatWait(now - arrivedAt)}
            </Text>
          </View>
          {canNoShow ? <Button label="Rider didn't show" variant="danger" size="pill" onPress={onNoShow} /> : null}
        </View>
      ) : null}

      {!pickup && cash && fare ? (
        <View style={styles.collect} accessible accessibilityLabel={`Collect ${fare} cash`}>
          <Text variant="title3">Collect</Text>
          <Text variant="display" tabular>
            {fare}
          </Text>
          <Text variant="title3">cash</Text>
        </View>
      ) : null}

      {/* Keyed by stop: every stop gets a fresh slider, so it can never stay
          stuck at the end when two stops share a label. It buzzes (medium)
          as it completes. */}
      {pickup ? (
        <SlideToConfirm
          key={stop.key}
          label={`Slide when ${name} is in`}
          doneLabel="Picked up"
          onConfirm={() => {
            if (stop.passengerStatus === "WAITING") act("arrived");
            act("pickup");
            onStep(stop, "pickup");
          }}
        />
      ) : (
        <SlideToConfirm
          key={stop.key}
          label={cash ? `Slide when you have ${fare ?? "the fare"}` : `Slide when ${name} is out`}
          doneLabel={cash ? "Cash collected" : "Dropped off"}
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

/** Back · "Ride alone · GH₵15" · ⋯, floating on the map. */
function TopBar({
  label,
  onBack,
  onMore,
  onLayout,
  syncing,
  farFromCampus,
}: {
  label: string;
  onBack: () => void;
  onMore: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
  syncing: boolean;
  farFromCampus: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.topBar, { paddingTop: insets.top + spacing[2] }]} onLayout={onLayout} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        {/* Minimise: the trip carries on; the banner on every tab brings the driver back. */}
        <IconButton variant="map" icon="arrow-back" accessibilityLabel="Go to Home. Your trip continues." onPress={onBack} />
        <View style={styles.pill} accessible accessibilityLabel={label}>
          <Text variant="bodyStrong" numberOfLines={1} tabular>
            {label}
          </Text>
        </View>
        <IconButton variant="map" icon="ellipsis-horizontal" accessibilityLabel="More actions" onPress={onMore} />
      </View>
      {syncing || farFromCampus ? (
        <View style={styles.statusRow} pointerEvents="none">
          {syncing ? (
            <StatusChip
              tone="neutral"
              icon="cloud-upload-outline"
              label="Sending…"
              style={styles.floating}
              accessibilityLabel="Sending. Waiting for a connection."
            />
          ) : null}
          {farFromCampus ? <StatusChip tone="warn" label="Far from campus" style={styles.floating} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mapLand },
  // ── Top bar
  topBar: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: spacing.gutter, paddingBottom: spacing[2], gap: spacing[2] },
  topRow: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  pill: {
    flex: 1,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing[4],
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    ...shadows.float,
  },
  statusRow: { flexDirection: "row", justifyContent: "center", gap: spacing[2] },
  floating: { ...shadows.float },
  // ── The sheet
  card: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[2],
    gap: spacing[4],
    ...shadows.sheet,
  },
  handle: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: colors.surface3 },
  nextStop: { gap: spacing[4] },
  nextHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing[2] },
  nextTitle: { gap: spacing[1], marginTop: -spacing[2] },
  // 24/800 in the spec: between title-2 and title-1, for the one instruction.
  instruction: { fontSize: 24, lineHeight: 30, fontWeight: "800", color: colors.ink },
  noteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
  },
  noteText: { flex: 1 },
  actions: { flexDirection: "row" },
  action: { flex: 1, alignItems: "center" },
  waitRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing[2] },
  waitChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radii.sm,
    backgroundColor: colors.surface2,
  },
  waitText: { color: colors.ink, fontWeight: "700" },
  collect: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: spacing[2] },
});
