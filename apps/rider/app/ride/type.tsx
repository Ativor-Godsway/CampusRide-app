import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { Alert, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { PaymentMethod, RiderCancelReason, RideType, TripEnd } from "@rida/shared";
import {
  MAX_PIN_ADJUST_METERS,
  PICKUP_NOTE_MAX_LENGTH,
  clampToRadius,
  estimateEtaMinutes,
  getSharedFarePerRider,
  isInServiceArea,
  mapFitPadding,
  movedEnd,
  pickupPlace,
  planTripStops,
  pointsKey,
  priceLoneRide,
  rideLeaveBehaviour,
  decodePolyline,
  stopsBeforeDropoff,
  tripEndBody,
  tripEndFromParams,
  tripEndParams,
} from "@rida/shared";
import {
  ActiveRideExistsError,
  activeRideQueryKey,
  Button,
  CampusMapView,
  type CampusMapZone,
  FadeIn,
  goHome as goToHomeTab,
  Text,
  cancelRide,
  colors,
  createRide,
  formatCedis,
  getActiveRide,
  radii,
  regionForCoordinates,
  shadows,
  rideQueryKey,
  Skeleton,
  SkeletonGroup,
  spacing,
  spokenCedis,
  submitRideDecision,
  switchRideType,
  typography,
  useAuth,
  useDriverLocation,
  useCarNotice,
  useRideTracking,
  useToast,
  RideRequestRefusedError,
  getRoadRoute,
  useLiveRoute,
  rateLimitText,
  BottomSheet,
  BottomSheetTextInput,
  Chip,
  IconButton,
  RideOptionCard,
  illustrations,
} from "@rida/mobile-shared";
import { CancelRideContent, type SwitchOffer } from "../../components/ride/CancelRideContent";
import {
  DriverArrivedContent,
  DriverOnTheWayContent,
  InRideContent,
} from "../../components/ride/DriverTripContent";
import { NoDriversPanel } from "../../components/ride/NoDriversPanel";
import { SearchingPanel } from "../../components/ride/SearchingPanel";
import { RideInProgressSheet } from "../../components/ride/RideInProgressSheet";
import { SafetySheet } from "../../components/ride/SafetySheet";
import { TripCancelledSheet, TripCompleteSheet } from "../../components/ride/TripEndSheet";
import { activeRideParams, useActiveRide } from "../../lib/activeRide";
import { haptics } from "../../lib/haptics";
import { usePlaces, useZones } from "../../lib/chooseRide";
import { shareTrip } from "../../lib/shareTrip";

/** The floating route pill: its height, and its gap below the status bar. */
const PILL_HEIGHT = 44;

/** One ride type on Choose a ride. */
interface RideOption {
  type: RideType;
  title: string;
  /** One short, TRUE line: "up to 4 riders" / "just you". */
  subtitle: string;
  farePesewas: number;
  /** Formatted with formatCedis, e.g. "GH₵7". */
  priceLabel: string;
  badge?: string;
}
const PILL_TOP_GAP = spacing.sm;
/** A first guess at the options sheet's height, until it reports its real one. */
const OPTIONS_SHEET_ESTIMATE = 360;
/** Sheet height changes smaller than this (a line of text) don't move the map's controls. */
const SHEET_HEIGHT_SLOP = 16;

/** HTTP status of an axios error, if any. */
function httpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

export default function RideTypeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  /**
   * Both ends as exact points (tripEndParams, "pickup" / "dropoff" prefixes),
   * plus: `rideId` when resuming an active ride; `from` ("plan" when opened
   * from Plan your ride, so Edit can simply go back); `openCancel` ("1": open
   * this ride's cancel steps as soon as it loads).
   */
  const params = useLocalSearchParams<Record<string, string>>();
  const initialPickup = useMemo<TripEnd>(
    () => tripEndFromParams("pickup", params) ?? { kind: "pin", latitude: 0, longitude: 0, label: "Pickup", placeId: null },
    // Read once: the pickup can then be moved on this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const dropoffEnd = useMemo<TripEnd>(
    () => tripEndFromParams("dropoff", params) ?? { kind: "pin", latitude: 0, longitude: 0, label: "Drop-off", placeId: null },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const { data: places = [] } = usePlaces();

  // ── "Move pin to the exact spot" and "Note for driver" (before requesting) ──
  const [pickupEnd, setPickupEnd] = useState<TripEnd>(initialPickup);
  const [adjusting, setAdjusting] = useState(false);
  const [adjustHint, setAdjustHint] = useState<string | null>(null);
  /** Re-places the pickup marker after each drag (it may have been clamped or refused). */
  const [pinVersion, setPinVersion] = useState(0);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);

  // ── Options phase ───────────────────────────────────────────────────────────
  const [selectedType, setSelectedType] = useState<RideType>("SHARED");
  const [selectedPaymentMethod] = useState<PaymentMethod>("CASH");
  const [submitting, setSubmitting] = useState(false);

  // ── Tracking phase (null = options phase, string = post-request or resume) ───
  const [activeRideId, setActiveRideId] = useState<string | null>(params.rideId ?? null);
  const [driverLocation, setDriverLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<"search" | "switch" | null>(null);
  /** The cancel steps, in place of the ride sheet's content. */
  const [cancelOpen, setCancelOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const { showToast, toast } = useToast();
  const [cancelling, setCancelling] = useState(false);
  const [switching, setSwitching] = useState(false);

  const queryClient = useQueryClient();
  const { data: activeRideSummary } = useActiveRide();
  /** Set once the rider has deliberately left (cancelled, finished, minimised). */
  const [leaving, setLeaving] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const { user } = useAuth();
  const { data: trackingData } = useRideTracking(activeRideId ?? undefined);

  // "Picking up 1 more rider on the way · ~3 min" when the driver adds a
  // rider while this rider is in the car. Shown for a few seconds.
  const [carNotice, setCarNotice] = useState<string | null>(null);
  useCarNotice(activeRideId ?? undefined, setCarNotice);
  useEffect(() => {
    if (!carNotice) return;
    const t = setTimeout(() => setCarNotice(null), 8_000);
    return () => clearTimeout(t);
  }, [carNotice]);

  useDriverLocation(activeRideId ?? undefined, (payload) => {
    setDriverLocation({ latitude: payload.lat, longitude: payload.lng });
  });

  const ride = trackingData?.ride;
  const driver = trackingData?.driver;
  // Phase 6b-3: this rider's own RidePassenger row.
  const myPassenger = ride?.passengers.find((p) => p.riderId === user?.id);
  /**
   * The rider's own leg status, purely own-trip — never derived from
   * co-passengers or any "another passenger" concept. For SHARED rides this
   * is exactly `myPassenger.status` (the driver app writes WAITING -> ARRIVED
   * -> PICKED_UP -> DROPPED_OFF independently per passenger). LONE rides
   * never write per-passenger status (it stays WAITING forever in the DB) —
   * for LONE only, this is derived from the ride-level status instead, which
   * remains the correct source of truth there.
   */
  const myLegStatus: "WAITING" | "ARRIVED" | "PICKED_UP" | "DROPPED_OFF" =
    ride?.type === "LONE"
      ? ride.status === "ARRIVED"
        ? "ARRIVED"
        : ride.status === "IN_PROGRESS"
          ? "PICKED_UP"
          : "WAITING"
      : myPassenger?.status === "ARRIVED" ||
          myPassenger?.status === "PICKED_UP" ||
          myPassenger?.status === "DROPPED_OFF"
        ? myPassenger.status
        : "WAITING";

  // #7 merged-rider reach: this request may have been absorbed into another
  // driver's car (CANCELLED / MERGED_INTO_ANOTHER_RIDE). Follow the pointer to
  // the anchor ride so useRideTracking listens on the correct room and
  // per-passenger events reach us. Anchor riders never hit this (their ride is
  // never merged).
  const isMerged =
    ride?.status === "CANCELLED" &&
    ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE" &&
    !!ride.mergedIntoRideId;

  useEffect(() => {
    if (isMerged && ride?.mergedIntoRideId && ride.mergedIntoRideId !== activeRideId) {
      setActiveRideId(ride.mergedIntoRideId);
    }
  }, [isMerged, ride?.mergedIntoRideId, activeRideId]);

  // A driver accepted: one success buzz, only on the live transition (not
  // when reopening a ride that was already matched).
  const previousStatus = useRef(ride?.status);
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = ride?.status;
    if ((before === "REQUESTED" || before === "AWAITING_RIDER_DECISION") && ride?.status === "MATCHED") {
      haptics.success();
    }
  }, [ride?.status]);

  // The driver reached the pickup: the same buzz, again only live (null until
  // the ride has loaded, so reopening an arrived ride stays quiet).
  const legSeen = ride ? myLegStatus : null;
  const previousLeg = useRef(legSeen);
  useEffect(() => {
    const before = previousLeg.current;
    previousLeg.current = legSeen;
    if (before === "WAITING" && legSeen === "ARRIVED") haptics.success();
  }, [legSeen]);

  // ── Fares ───────────────────────────────────────────────────────────────────
  // Before a ride exists: the same @rida/shared pricing functions the server
  // locks fares with (createRide / switchRideType), so the prices shown are
  // the prices charged. Shared is flat per rider regardless of occupancy.
  const sharedFare = useMemo(() => getSharedFarePerRider(1), []);
  const loneFare = useMemo(() => priceLoneRide().fare, []);
  const fareFor = useCallback((type: RideType) => (type === "SHARED" ? sharedFare : loneFare), [sharedFare, loneFare]);

  // No pickup time here: no driver is matched yet, so there is no real ETA to
  // show, and we never make one up.
  const options: RideOption[] = useMemo(
    () => [
      {
        type: "SHARED",
        title: "Shared",
        subtitle: "up to 4 riders",
        farePesewas: sharedFare,
        priceLabel: formatCedis(sharedFare),
        badge: "Best value",
      },
      {
        type: "LONE",
        title: "Ride alone",
        subtitle: "just you",
        farePesewas: loneFare,
        priceLabel: formatCedis(loneFare),
      },
    ],
    [sharedFare, loneFare],
  );
  const selectedOption = options.find((o) => o.type === selectedType) ?? options[0]!;

  // Once a ride exists, the SERVER's type and this rider's locked fare are the
  // truth (it may have been switched, or be a resumed ride booked before a
  // price change: it keeps the price it was booked at).
  const rideType: RideType = ride?.type ?? selectedType;
  const priceLabel = formatCedis(myPassenger?.lockedFare ?? fareFor(rideType));

  // ── Map coords & region ─────────────────────────────────────────────────────
  const pickupCoord = useMemo(
    () => ({ latitude: pickupEnd.latitude, longitude: pickupEnd.longitude }),
    [pickupEnd.latitude, pickupEnd.longitude],
  );
  const dropoffCoord = useMemo(
    () => ({ latitude: dropoffEnd.latitude, longitude: dropoffEnd.longitude }),
    [dropoffEnd.latitude, dropoffEnd.longitude],
  );

  // The road from the pickup pin to the drop-off pin (POST /routes/legs:
  // OSRM, cached by the server). Until it answers, or if it can't, a dashed
  // straight line.
  const { data: tripRoute } = useQuery({
    queryKey: ["roadRoute", pointsKey([pickupCoord, dropoffCoord])],
    queryFn: () => getRoadRoute([pickupCoord, dropoffCoord]),
    staleTime: Infinity,
    retry: 1,
  });

  // While the driver comes for the rider: the road from the driver to the
  // exact pickup pin; once picked up, from the driver to the drop-off pin.
  // Asked for once, then re-asked only if the driver leaves it (useLiveRoute).
  const legStage: "toPickup" | "toDropoff" | null =
    ride && (ride.status === "MATCHED" || ride.status === "ARRIVED" || ride.status === "IN_PROGRESS")
      ? myLegStatus === "PICKED_UP"
        ? "toDropoff"
        : myLegStatus === "DROPPED_OFF"
          ? null
          : "toPickup"
      : null;
  const liveStops = useMemo(
    () => (legStage === "toPickup" ? [pickupCoord] : legStage === "toDropoff" ? [dropoffCoord] : []),
    [legStage, pickupCoord, dropoffCoord],
  );
  const live = useLiveRoute({ from: driverLocation, stops: liveStops, enabled: legStage !== null && driverLocation !== null });

  const { routeLine, routeIsRoad, routeCredit } = useMemo(() => {
    if (live.path && live.path.length >= 2) {
      return { routeLine: live.path, routeIsRoad: live.source === "osrm", routeCredit: live.attribution ?? undefined };
    }
    const road = tripRoute ? decodePolyline(tripRoute.polyline) : [];
    return road.length >= 2
      ? { routeLine: road, routeIsRoad: tripRoute?.source === "osrm", routeCredit: tripRoute?.attribution }
      : { routeLine: [pickupCoord, dropoffCoord], routeIsRoad: false, routeCredit: undefined };
  }, [live.path, live.source, live.attribution, tripRoute, pickupCoord, dropoffCoord]);

  /**
   * Phase 4 ETA. Straight-line distance from the driver's last reported
   * position, padded for road circuity (see @rida/shared estimateEtaMinutes)
   * — there is no routing or traffic data in this project, and the copy says
   * "about" so it reads as the estimate it is.
   *
   * Null until the first driver_location ping arrives, which is why the
   * caller falls back to "Your driver is getting ready" rather than showing
   * a number invented from nothing.
   */
  const roadEtaMinutes = live.secondsToFirstStop !== null ? Math.max(1, Math.round(live.secondsToFirstStop / 60)) : null;
  const etaToPickup = useMemo(
    () => (legStage === "toPickup" && roadEtaMinutes !== null ? roadEtaMinutes : estimateEtaMinutes(driverLocation, pickupCoord)),
    [legStage, roadEtaMinutes, driverLocation, pickupCoord],
  );
  const etaToDropoff = useMemo(
    () => (legStage === "toDropoff" && roadEtaMinutes !== null ? roadEtaMinutes : estimateEtaMinutes(driverLocation, dropoffCoord)),
    [legStage, roadEtaMinutes, driverLocation, dropoffCoord],
  );

  const region = useMemo(() => {
    const points = [pickupCoord, dropoffCoord];
    if (driverLocation) points.push(driverLocation);
    return regionForCoordinates(points, 0.8);
  }, [pickupCoord, dropoffCoord, driverLocation]);

  const mapZones = useMemo(() => {
    const zones: CampusMapZone[] = [
      { id: "pickup", ...pickupCoord, label: pickupEnd.label, role: "pickup", version: pinVersion },
      { id: "dropoff", ...dropoffCoord, label: dropoffEnd.label, role: "dropoff" },
    ];
    if (driverLocation) {
      zones.push({ id: "driver", ...driverLocation, label: "Driver", role: "driver" });
    }
    return zones;
  }, [pickupCoord, dropoffCoord, driverLocation, pickupEnd.label, dropoffEnd.label, pinVersion]);

  // Shared, in the car: "1 more stop before yours". The driver app's own stop
  // order (planTripStops); other riders' exact pins are hidden from this
  // rider, so their stops are placed at their zones.
  const { data: zones } = useZones();
  const stopsBefore = useMemo(() => {
    if (ride?.type !== "SHARED" || myLegStatus !== "PICKED_UP" || !myPassenger || !zones) return null;
    const plan = planTripStops({
      passengers: ride.passengers,
      zones: new Map(zones.map((z) => [z.id, z])),
      from: driverLocation,
    });
    return stopsBeforeDropoff(plan, myPassenger.id);
  }, [ride?.type, ride?.passengers, myLegStatus, myPassenger, zones, driverLocation]);

  // The pickup in sentences ("Asking drivers near Akuafo Hall"): a real
  // place, never "Current location". This rider's own zone as the fallback.
  const myPickupZoneName = zones?.find((z) => z.id === (myPassenger?.pickupZoneId ?? ride?.pickupZoneId))?.name;
  const pickupWhere = useMemo(
    () => pickupPlace(pickupEnd, places, myPickupZoneName),
    [pickupEnd, places, myPickupZoneName],
  );

  // ── Phase ───────────────────────────────────────────────────────────────────
  const isSearching = activeRideId !== null && (!ride || ride.status === "REQUESTED" || isMerged);
  const hasDriver = ride?.status === "MATCHED" || ride?.status === "ARRIVED";
  /** Over: a modal sheet over the dimmed map takes the ride sheet's place. */
  const tripEnded: "completed" | "cancelled" | "driverCancelled" | null =
    myPassenger?.status === "CANCELLED"
      ? "driverCancelled"
      : ride?.status === "COMPLETED"
        ? "completed"
        : ride?.status === "CANCELLED" && !isMerged
          ? "cancelled"
          : null;
  const driverComing = hasDriver && !!driver && (myLegStatus === "WAITING" || myLegStatus === "ARRIVED");

  // Still unclaimed and holding only this rider: the server will accept a
  // type switch (POST /rides/:id/switch — same rule, checked again there).
  const canSwitch =
    !!ride &&
    !isMerged &&
    (ride.status === "REQUESTED" || ride.status === "AWAITING_RIDER_DECISION") &&
    ride.occupancy === 1;
  const switchTarget: RideType = rideType === "SHARED" ? "LONE" : "SHARED";
  const switchOffer: SwitchOffer | null = canSwitch
    ? {
        toType: switchTarget,
        label: switchTarget === "LONE" ? "Switch to Ride alone" : "Switch to Shared",
        priceLabel: formatCedis(fareFor(switchTarget)),
        priceSpoken: spokenCedis(fareFor(switchTarget)),
      }
    : null;

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    setSubmitting(true);
    try {
      const created = await createRide({
        pickup: tripEndBody(pickupEnd),
        dropoff: tripEndBody(dropoffEnd),
        ...(note.trim() ? { pickupNote: note.trim() } : {}),
        type: selectedType,
        paymentMethod: selectedPaymentMethod,
      });
      setAdjusting(false);
      setActiveRideId(created.id);
      void queryClient.invalidateQueries({ queryKey: activeRideQueryKey });
    } catch (err) {
      if (err instanceof ActiveRideExistsError) {
        // Not an error to show: offer the way to the ride that's in the way.
        await queryClient.invalidateQueries({ queryKey: activeRideQueryKey });
        setConflictOpen(true);
      } else if (err instanceof RideRequestRefusedError) {
        // Outside the area, a place that's gone, the same spot twice: the server's own words.
        Alert.alert("Couldn't request this ride", err.message);
      } else {
        Alert.alert("Couldn't request a ride", rateLimitText(err) ?? "Please check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * The rider dragged the pickup pin. It may move up to MAX_PIN_ADJUST_METERS
   * from where it started (further lands it on that circle), and never out
   * of the CampusRide area. The label follows: the chosen place's name while
   * it's near it, else "Near <place>".
   */
  function onPickupDragged(point: { latitude: number; longitude: number }) {
    setPinVersion((v) => v + 1);
    const kept = clampToRadius(initialPickup, point);
    if (!isInServiceArea(kept)) {
      setAdjustHint("That's outside the CampusRide area. Keep the pin on campus.");
      return;
    }
    setPickupEnd(movedEnd(initialPickup, kept, places));
    setAdjustHint(
      kept.clamped
        ? `The pin can move up to ${MAX_PIN_ADJUST_METERS} m. To be picked up somewhere else, edit your pickup.`
        : null,
    );
    haptics.selection();
  }

  async function refreshRide() {
    if (activeRideId) await queryClient.invalidateQueries({ queryKey: rideQueryKey(activeRideId) });
  }

  async function handleSearchAgain() {
    if (!activeRideId) return;
    setDecisionBusy("search");
    try {
      await submitRideDecision(activeRideId, "KEEP_WAITING");
      // Refetch so broadcastStartedAt is fresh for the restarted countdown.
      await refreshRide();
    } catch (err) {
      Alert.alert("Something went wrong", rateLimitText(err) ?? "Please try again.");
    } finally {
      setDecisionBusy(null);
    }
  }

  /** In-place switch; the ride keeps its id, so there is never a second (or no) ride. */
  async function handleSwitch(toType: RideType, source: "sheet" | "no_drivers") {
    if (!activeRideId) return;
    if (source === "sheet") setSwitching(true);
    else setDecisionBusy("switch");
    try {
      await switchRideType(activeRideId, toType);
      haptics.success();
      setCancelOpen(false);
      await refreshRide();
      void queryClient.invalidateQueries({ queryKey: activeRideQueryKey });
    } catch (err) {
      await refreshRide();
      if (httpStatus(err) === 409) {
        Alert.alert(
          "Couldn't switch",
          "Your ride just changed — a driver may have accepted it. Check the latest status.",
        );
      } else {
        Alert.alert("Couldn't switch", rateLimitText(err) ?? "Please check your connection and try again.");
      }
    } finally {
      setSwitching(false);
      setDecisionBusy(null);
    }
  }

  async function handleConfirmCancel(reason: RiderCancelReason, note: string) {
    if (!activeRideId) return;
    setCancelling(true);
    try {
      await cancelRide(activeRideId, { reason, note });
      setCancelOpen(false);
      void queryClient.invalidateQueries({ queryKey: activeRideQueryKey });
      // A deliberate exit: lift the leave guard, then go (see effect below).
      setLeaving(true);
    } catch (err) {
      if (httpStatus(err) === 409) {
        await refreshRide();
        setCancelOpen(false);
        Alert.alert("Can't cancel now", "This ride can no longer be cancelled.");
      } else {
        Alert.alert("Couldn't cancel", rateLimitText(err) ?? "Please check your connection and try again.");
      }
    } finally {
      setCancelling(false);
    }
  }

  /** "Share trip": where the rider is going and the car they're in. */
  function shareThisTrip() {
    if (driver) void shareTrip({ pickup: pickupWhere?.name ?? null, dropoff: dropoffEnd.label, driver });
  }

  /** Closes everything above the tabs, so "home" is Home even from Plan → Choose. */
  const goHome = useCallback(() => goToHomeTab(router), [router]);

  // ── Never lose an active ride ───────────────────────────────────────────────
  // Back arrow, iOS swipe-back and Android back all try to REMOVE this
  // screen; while a ride is going on that is intercepted. Still cancellable
  // (searching, or waiting for the driver) → the cancel steps, so leaving is
  // a deliberate choice. On the trip → minimise to Home; the ride carries on
  // and the banner there brings the rider back.
  const leaveBehaviour = rideLeaveBehaviour({
    status: ride?.status,
    type: ride?.type ?? selectedType,
    legStatus: myPassenger?.status ?? null,
  });
  usePreventRemove(!leaving && leaveBehaviour !== "leave", () => {
    if (leaveBehaviour === "minimise") setLeaving(true);
    // Back from the cancel steps returns to the ride.
    else setCancelOpen((open) => !open);
  });
  // Picked up (or the ride ended) while the cancel steps were showing: there
  // is nothing left to cancel.
  const canCancel = leaveBehaviour === "confirm";
  useEffect(() => {
    if (!canCancel) setCancelOpen(false);
  }, [canCancel]);
  useEffect(() => {
    // Runs after the render that switched the guard off, so the pop is allowed.
    if (leaving) goHome();
  }, [leaving, goHome]);

  // "Cancel it" from Choose a ride lands here with openCancel=1.
  const autoOpenedCancel = useRef(false);
  useEffect(() => {
    if (!params.openCancel || autoOpenedCancel.current || !ride) return;
    autoOpenedCancel.current = true;
    if (leaveBehaviour === "confirm") setCancelOpen(true);
  }, [params.openCancel, ride, leaveBehaviour]);

  // Choose a ride opened while another ride is still going on: say so up
  // front (the server would refuse the request anyway).
  const conflictShownOnOpen = useRef(false);
  useEffect(() => {
    if (activeRideId !== null || conflictShownOnOpen.current || !activeRideSummary) return;
    conflictShownOnOpen.current = true;
    setConflictOpen(true);
  }, [activeRideId, activeRideSummary]);

  const [openingExisting, setOpeningExisting] = useState(false);
  async function openExistingRide(openCancel: boolean) {
    setOpeningExisting(true);
    try {
      const existing =
        activeRideSummary ??
        (await queryClient.fetchQuery({ queryKey: activeRideQueryKey, queryFn: getActiveRide }));
      setConflictOpen(false);
      if (!existing) {
        Alert.alert("That ride has ended", "You can request a new ride now.");
        return;
      }
      router.replace({ pathname: "/ride/type", params: activeRideParams(existing, { openCancel }) });
    } catch {
      Alert.alert("Couldn't open your ride", "Please check your connection and try again.");
    } finally {
      setOpeningExisting(false);
    }
  }

  const inOptions = activeRideId === null;

  // ── Map framing ─────────────────────────────────────────────────────────────
  // Fit pickup + drop-off (and the driver, once there is one) into the map
  // area the rider can actually see: below the route pill, above the sheet.
  // The map re-fits only when the phase changes (driver assigned, arrived,
  // picked up) or the rider taps recentre — not each time the sheet settles
  // at a new height, which re-zoomed the map every few seconds. Each fit uses
  // the sheet's latest height.
  const [sheetHeight, setSheetHeight] = useState(inOptions ? OPTIONS_SHEET_ESTIMATE : windowHeight * 0.55);
  const onSheetChange = useCallback(
    (_index: number, position: number) => {
      if (position <= 0) return;
      const next = Math.round(windowHeight - position);
      setSheetHeight((prev) => (Math.abs(next - prev) < SHEET_HEIGHT_SLOP ? prev : next));
    },
    [windowHeight],
  );
  const framePhase = inOptions ? "choosing" : isSearching ? "searching" : `driver-${myLegStatus}`;
  const hasDriverPin = driverLocation !== null;
  // Framed on where the pickup STARTED while choosing, so dragging the pin
  // doesn't swing the map; on the moved pin once the ride is requested.
  const framePickup = inOptions ? initialPickup : pickupCoord;
  const fitTo = useMemo(
    () => (hasDriverPin && driverLocation ? [framePickup, dropoffCoord, driverLocation] : [framePickup, dropoffCoord]),
    // Re-fit when the driver first appears, not on every GPS ping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [framePickup, dropoffCoord, hasDriverPin],
  );
  const fitPadding = useMemo(
    () =>
      mapFitPadding({
        mapHeight: windowHeight,
        topOverlay: insets.top + PILL_TOP_GAP + PILL_HEIGHT,
        bottomOverlay: sheetHeight,
      }),
    [windowHeight, insets.top, sheetHeight],
  );

  /** The pill's back arrow. While a ride is active the leave guard above catches it. */
  function goBack() {
    if (router.canGoBack()) router.back();
    else goHome();
  }

  /** Back to Plan your ride with both ends filled in. */
  function editRoute() {
    if (params.from === "plan" && router.canGoBack()) {
      router.back();
      return;
    }
    router.replace({
      pathname: "/ride/location",
      params: { ...tripEndParams("pickup", pickupEnd), ...tripEndParams("dropoff", dropoffEnd) },
    });
  }

  // Reopening a ride from "Your rides": nothing to show until it loads.
  const resumingUnloaded = Boolean(params.rideId) && !ride;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <CampusMapView
        initialRegion={region}
        zones={mapZones}
        routeLine={routeLine}
        routeIsRoad={routeIsRoad}
        routeAttribution={routeCredit}
        height={windowHeight}
        light
        showRecenter
        rounded={false}
        pulseZoneId={isSearching ? "pickup" : undefined}
        fitTo={fitTo}
        fitPadding={fitPadding}
        refitKey={framePhase}
        controlsBottomInset={sheetHeight}
        draggableZoneId={inOptions && adjusting ? "pickup" : undefined}
        onZoneDragEnd={(_id, point) => onPickupDragged(point)}
        circle={inOptions && adjusting ? { center: initialPickup, radiusMeters: MAX_PIN_ADJUST_METERS } : null}
      />

      {carNotice ? (
        <View
          style={[styles.carNotice, { top: insets.top + PILL_TOP_GAP + 64 }]}
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
        >
          <Ionicons name="people" size={16} color={colors.white} />
          <Text variant="bodySmall" style={styles.carNoticeText}>
            {carNotice}
          </Text>
        </View>
      ) : null}

      <RoutePill
        top={insets.top + PILL_TOP_GAP}
        // Once requested, a real place ("Alexander Kwapong Hall"), never "Current location".
        pickupZoneName={inOptions ? pickupEnd.label : (pickupWhere?.name ?? pickupEnd.label)}
        dropoffZoneName={dropoffEnd.label}
        onBack={goBack}
        // A requested ride's route can't change, so Edit only exists before.
        onEdit={inOptions ? editRoute : undefined}
        // Mockup 06: while the driver comes, only where to meet matters.
        pickupOnly={driverComing}
      />

      {inOptions ? (
        // Sized to its content (no fixed snap points), so the Cash + Request
        // bar is always the last thing in view and nothing sits behind it.
        <BottomSheet
          key="options"
          maxHeightRatio={0.85}
          onChange={onSheetChange}
          contentStyle={styles.optionsSheet}
          // The one action, pinned at the bottom (above the keyboard while the
          // note is being typed).
          footer={
            <Button
              label={`Request ${selectedOption.title}`}
              onPress={() => void handleSubmit()}
              loading={submitting}
              accessibilityHint={`${spokenCedis(selectedOption.farePesewas)}, paid in cash`}
            />
          }
        >
          <Text variant="title2" accessibilityRole="header">
            Choose a ride
          </Text>
          <View style={styles.optionList} accessibilityRole="radiogroup" accessibilityLabel="Choose a ride">
            {options.map((option) => (
              <RideOptionCard
                key={option.type}
                image={option.type === "SHARED" ? illustrations.carShared : illustrations.carStandard}
                title={option.title}
                badge={option.badge}
                subtitle={option.subtitle}
                price={option.priceLabel}
                selected={selectedType === option.type}
                // The card plays the selection haptic itself.
                onPress={() => setSelectedType(option.type)}
              />
            ))}
          </View>

          <View style={styles.optionChips}>
            {/* Cash-only launch (Phase 1): MoMo is intentionally not offered
                — a MOMO ride couldn't be settled while digital payment is
                off server-side. A statement, not a picker. */}
            <Chip
              kind="choice"
              icon="cash-outline"
              label="Cash"
              accessibilityRole="text"
              accessibilityLabel="Payment: cash. Pay your driver at the end of the trip."
            />
            <Chip
              kind="choice"
              icon="locate-outline"
              label="Exact pickup"
              selected={adjusting}
              accessibilityLabel={adjusting ? "Done moving the pickup pin" : "Move the pickup pin to the exact spot"}
              onPress={() => {
                setAdjusting((on) => !on);
                setAdjustHint(null);
              }}
            />
            <Chip
              kind="choice"
              icon="chatbox-outline"
              label={note.trim() ? "Note added" : "Note"}
              selected={Boolean(note.trim())}
              accessibilityLabel={note.trim() ? `Note for your driver: ${note.trim()}. Edit it` : "Add a note for your driver"}
              onPress={() => setNoteOpen(true)}
            />
          </View>

          <PickupExtras
            adjusting={adjusting}
            hint={adjustHint}
            note={note}
            noteOpen={noteOpen}
            onNoteChange={setNote}
            onNoteDone={() => setNoteOpen(false)}
          />
        </BottomSheet>
      ) : tripEnded ? null : (
      // Sized to its content, so searching stays compact over the map.
      <BottomSheet
        key="tracking"
        maxHeightRatio={0.9}
        onChange={onSheetChange}
        scrollable
        contentStyle={styles.sheetContent}
      >
          {resumingUnloaded ? (
            <SkeletonGroup label="Loading your ride" style={styles.resumeSkeleton}>
              <Skeleton width={120} height={120} radius={radii.full} style={styles.centerSelf} />
              <Skeleton width="60%" height={24} style={styles.centerSelf} />
              <Skeleton width="80%" height={14} style={styles.centerSelf} />
              <Skeleton height={120} radius={radii.lg} />
            </SkeletonGroup>
          ) : activeRideId !== null && cancelOpen && canCancel ? (
            // The cancel steps take the sheet's place; never a second sheet.
            <FadeIn key="cancel">
              <CancelRideContent
                stage={hasDriver ? "driver_assigned" : "searching"}
                switchOffer={switchOffer}
                switching={switching}
                cancelling={cancelling}
                onKeep={() => setCancelOpen(false)}
                onSwitch={(toType) => void handleSwitch(toType, "sheet")}
                onConfirmCancel={(reason, note) => void handleConfirmCancel(reason, note)}
              />
            </FadeIn>
          ) : activeRideId !== null && (
            <>
              {isSearching && (
                <FadeIn key="searching">
                  <SearchingPanel
                    pickupZoneName={pickupEnd.label}
                    pickupPlaceName={pickupWhere?.name ?? null}
                    dropoffZoneName={dropoffEnd.label}
                    rideType={rideType}
                    priceLabel={priceLabel}
                    broadcastStartedAt={ride?.broadcastStartedAt}
                    onCancel={() => setCancelOpen(true)}
                  />
                </FadeIn>
              )}

              {ride?.status === "AWAITING_RIDER_DECISION" && (
                <FadeIn key="no-drivers">
                  <NoDriversPanel
                    switchOffer={
                      canSwitch
                        ? switchTarget === "LONE"
                          ? `Switch to Ride alone · ${formatCedis(loneFare)}`
                          : `Switch to Shared · ${formatCedis(sharedFare)}`
                        : null
                    }
                    busy={decisionBusy}
                    onSearchAgain={() => void handleSearchAgain()}
                    onSwitch={() => void handleSwitch(switchTarget, "no_drivers")}
                    onCancel={() => setCancelOpen(true)}
                  />
                </FadeIn>
              )}

              {(ride?.status === "MATCHED" ||
                ride?.status === "ARRIVED" ||
                ride?.status === "IN_PROGRESS") &&
                driver &&
                (myLegStatus === "DROPPED_OFF" ? (
                  <FadeIn key="leg-done">
                    <MyLegDoneContent dropoffZoneName={dropoffEnd.label} />
                  </FadeIn>
                ) : myLegStatus === "PICKED_UP" ? (
                  <FadeIn key="in-ride">
                    <InRideContent
                      driver={driver}
                      dropoffName={dropoffEnd.label}
                      etaMinutes={etaToDropoff}
                      stopsBefore={stopsBefore}
                      onShare={shareThisTrip}
                      onSafety={() => setSafetyOpen(true)}
                    />
                  </FadeIn>
                ) : myLegStatus === "ARRIVED" ? (
                  <FadeIn key="driver-arrived">
                    <DriverArrivedContent
                      driver={driver}
                      pickup={pickupWhere}
                      onShare={shareThisTrip}
                      onSafety={() => setSafetyOpen(true)}
                      onCancel={() => setCancelOpen(true)}
                    />
                  </FadeIn>
                ) : (
                  <FadeIn key="driver-on-the-way">
                    <DriverOnTheWayContent
                      driver={driver}
                      etaMinutes={etaToPickup}
                      onShare={shareThisTrip}
                      onSafety={() => setSafetyOpen(true)}
                      onCancel={() => setCancelOpen(true)}
                    />
                  </FadeIn>
                ))}

            </>
          )}
      </BottomSheet>
      )}

      {tripEnded === "completed" && ride ? (
        <TripCompleteSheet
          rideId={ride.id}
          rideType={ride.type}
          fareSummary={trackingData?.fareSummary}
          driver={driver}
          dropoffName={dropoffEnd.label}
          completedAt={ride.completedAt}
          onDone={() => setLeaving(true)}
        />
      ) : tripEnded === "driverCancelled" ? (
        <TripCancelledSheet
          title="Driver cancelled"
          message="Your driver cancelled your pickup. Please request a ride again."
          onDone={() => setLeaving(true)}
        />
      ) : tripEnded === "cancelled" ? (
        <TripCancelledSheet onDone={() => setLeaving(true)} />
      ) : null}

      {inOptions ? (
        <RideInProgressSheet
          visible={conflictOpen}
          ride={activeRideSummary ?? null}
          busy={openingExisting}
          onGoToRide={() => void openExistingRide(false)}
          onCancelIt={() => void openExistingRide(true)}
          onDismiss={() => setConflictOpen(false)}
        />
      ) : null}

      {activeRideId !== null ? (
        <SafetySheet
          visible={safetyOpen}
          rideId={ride?.id ?? activeRideId}
          onDismiss={() => setSafetyOpen(false)}
          onShareTrip={shareThisTrip}
          showToast={showToast}
        />
      ) : null}

      {toast}
    </View>
  );
}

// ── Pickup pin + note ─────────────────────────────────────────────────────────

/**
 * Under the chips, only when wanted: what "Exact pickup" means while the pin
 * can be dragged (within 200 m), and the note for the driver ("At the main
 * gate, blue shirt") once "Note" is tapped.
 */
function PickupExtras({
  adjusting,
  hint,
  note,
  noteOpen,
  onNoteChange,
  onNoteDone,
}: {
  adjusting: boolean;
  hint: string | null;
  note: string;
  noteOpen: boolean;
  onNoteChange: (note: string) => void;
  onNoteDone: () => void;
}) {
  if (!adjusting && !noteOpen) return null;
  return (
    <View style={styles.pickupExtras}>
      {adjusting ? (
        <Text variant="subhead" color="secondary" accessibilityLiveRegion="polite">
          {hint ?? "Drag the green pin to the exact spot — up to 200 m from here."}
        </Text>
      ) : null}
      {noteOpen ? (
        <View>
          {/* The sheet's own input: typing moves the sheet above the keyboard. */}
          <BottomSheetTextInput
            value={note}
            onChangeText={(t) => onNoteChange(t.slice(0, PICKUP_NOTE_MAX_LENGTH))}
            placeholder="Note for driver, e.g. At the main gate, blue shirt"
            placeholderTextColor={colors.ink3}
            maxLength={PICKUP_NOTE_MAX_LENGTH}
            style={styles.noteInput}
            accessibilityLabel="Note for driver"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={onNoteDone}
          />
          <Text variant="caption" color="tertiary" style={styles.noteCount}>
            {note.length}/{PICKUP_NOTE_MAX_LENGTH}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Route pill ────────────────────────────────────────────────────────────────

/**
 * Floats over the top of the map: back · "Pickup → Drop-off" · Edit. Takes
 * the place of the route text that used to sit inside the sheet. While the
 * driver is coming it says only "● Pickup: Legon Barrier".
 */
function RoutePill({
  top,
  pickupZoneName,
  dropoffZoneName,
  onBack,
  onEdit,
  pickupOnly = false,
}: {
  top: number;
  pickupZoneName: string;
  dropoffZoneName: string;
  onBack: () => void;
  /** Tapping the route goes back to change it (only before the ride is requested). */
  onEdit?: () => void;
  pickupOnly?: boolean;
}) {
  if (pickupOnly) {
    return (
      <View style={[styles.topBar, { top }]} pointerEvents="box-none">
        <IconButton variant="map" icon="arrow-back" accessibilityLabel="Back" onPress={onBack} />
        <View style={[styles.pill, styles.pickupPill]} accessible accessibilityLabel={`Pickup: ${pickupZoneName}`}>
          <View style={styles.pickupDot} />
          <Text variant="bodyStrong" numberOfLines={1} style={styles.pillRoute}>
            Pickup: {pickupZoneName}
          </Text>
        </View>
      </View>
    );
  }
  const route = (
    <Text variant="bodyStrong" numberOfLines={1} style={styles.pillRoute}>
      {pickupZoneName} → {dropoffZoneName}
    </Text>
  );
  return (
    <View style={[styles.topBar, { top }]} pointerEvents="box-none">
      <IconButton variant="map" icon="arrow-back" accessibilityLabel="Back" onPress={onBack} />
      {onEdit ? (
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel={`From ${pickupZoneName} to ${dropoffZoneName}. Change the route`}
          style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
        >
          {route}
        </Pressable>
      ) : (
        <View style={styles.pill} accessible accessibilityLabel={`From ${pickupZoneName} to ${dropoffZoneName}`}>
          {route}
        </View>
      )}
    </View>
  );
}

// ── Tracking phase content ────────────────────────────────────────────────────

/**
 * Phase 6b-3: shown once THIS rider's own passenger row is DROPPED_OFF, even
 * if the overall ride isn't COMPLETED yet (other passengers may still be
 * riding). No fare/rating here — that needs the ride-level fareSummary,
 * which the backend only computes once the whole ride completes; this is
 * purely a "your leg is done" acknowledgement in the meantime.
 */
function MyLegDoneContent({ dropoffZoneName }: { dropoffZoneName: string }) {
  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <View style={styles.doneBadge}>
          <Ionicons name="checkmark" size={24} color={colors.onBrand} />
        </View>
        <View style={styles.stateHeading}>
          <Text variant="title2">You&apos;re at {dropoffZoneName}</Text>
          <Text variant="subhead" color="secondary">
            Wrapping up the rest of the trip — your fare summary will appear shortly.
          </Text>
        </View>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // A filled field, as Input (docs/design-system.md): surface-2, radius 14.
  noteInput: {
    minHeight: 48,
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    fontSize: typography.size.md,
    color: colors.ink,
  },
  noteCount: { textAlign: "right", marginTop: 2 },
  carNotice: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceDark,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadows.md,
  },
  carNoticeText: { color: colors.white, flex: 1, fontWeight: "600" },
  container: { flex: 1 },
  sheetContent: { gap: spacing.lg },
  // ── Options
  optionsSheet: { gap: spacing.md },
  optionList: { gap: spacing.xs },
  optionChips: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  pickupExtras: { gap: spacing[2] },
  // ── Route pill
  topBar: {
    position: "absolute",
    left: spacing.gutter,
    right: spacing.gutter,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
  },
  // The white route pill (mockup 05), as tall as the round back button beside it.
  pill: {
    flexShrink: 1,
    height: PILL_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: spacing[4],
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    ...shadows.float,
  },
  pillPressed: { backgroundColor: colors.surface2 },
  pickupPill: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  pickupDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.green500 },
  pillRoute: { flexShrink: 1 },
  resumeSkeleton: { gap: spacing.lg, paddingTop: spacing.md },
  centerSelf: { alignSelf: "center" },
  // ── State panels
  section: { gap: spacing.md },
  stateHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  stateHeading: { flex: 1, gap: 4 },
  doneBadge: {
    width: 40,
    height: 40,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.green500,
  },
});
