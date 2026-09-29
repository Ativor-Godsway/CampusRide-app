import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { Alert, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import BottomSheet, { BottomSheetScrollView, BottomSheetView } from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import type { PaymentMethod, RideCompletedFareSummary, RiderCancelReason, RideType } from "@rida/shared";
import {
  cloudinaryAvatar,
  estimateEtaMinutes,
  formatEta,
  getSharedFarePerRider,
  mapFitPadding,
  priceLoneRide,
  rideLeaveBehaviour,
} from "@rida/shared";
import {
  ActiveRideExistsError,
  activeRideQueryKey,
  Button,
  Card,
  CampusMapView,
  type CampusMapZone,
  FadeIn,
  LoadingState,
  ServiceIcon,
  Text,
  callPhone,
  cancelRide,
  colors,
  createRide,
  formatCedis,
  getActiveRide,
  raiseSos,
  radii,
  regionForCoordinates,
  shadows,
  rideQueryKey,
  Skeleton,
  SkeletonGroup,
  spacing,
  spokenCedis,
  submitRating,
  submitRideDecision,
  switchRideType,
  typography,
  useAuth,
  useDriverLocation,
  useRideTracking,
  type RideDriverInfo,
} from "@rida/mobile-shared";
import { CancelRideSheet, type SwitchOffer } from "../../components/ride/CancelRideSheet";
import { NoDriversPanel } from "../../components/ride/NoDriversPanel";
import { RideOptionCard, type RideOption } from "../../components/ride/RideOptionCard";
import { SearchingPanel } from "../../components/ride/SearchingPanel";
import { RideInProgressSheet } from "../../components/ride/RideInProgressSheet";
import { activeRideParams, useActiveRide } from "../../lib/activeRide";
import { haptics } from "../../lib/haptics";

const STARS = [1, 2, 3, 4, 5];

/** The floating route pill: its height, and its gap below the status bar. */
const PILL_HEIGHT = 48;
const PILL_TOP_GAP = spacing.sm;
/** A first guess at the options sheet's height, until it reports its real one. */
const OPTIONS_SHEET_ESTIMATE = 360;

/** HTTP status of an axios error, if any. */
function httpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

export default function RideTypeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  const params = useLocalSearchParams<{
    pickupZoneId: string;
    dropoffZoneId: string;
    pickupZoneName: string;
    dropoffZoneName: string;
    pickupLat: string;
    pickupLng: string;
    dropoffLat: string;
    dropoffLng: string;
    /** Present when resuming an active ride from the "Your rides" tab. */
    rideId?: string;
    /** "plan" when opened from Plan your ride, so Edit can simply go back. */
    from?: string;
    /** "1": open this ride's cancel sheet as soon as it loads ("Cancel it"). */
    openCancel?: string;
  }>();

  // ── Options phase ───────────────────────────────────────────────────────────
  const [selectedType, setSelectedType] = useState<RideType>("SHARED");
  const [selectedPaymentMethod] = useState<PaymentMethod>("CASH");
  const [submitting, setSubmitting] = useState(false);

  // ── Tracking phase (null = options phase, string = post-request or resume) ───
  const [activeRideId, setActiveRideId] = useState<string | null>(params.rideId ?? null);
  const [driverLocation, setDriverLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<"search" | "switch" | null>(null);
  const [cancelSheetOpen, setCancelSheetOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [switching, setSwitching] = useState(false);

  const queryClient = useQueryClient();
  const { data: activeRideSummary } = useActiveRide();
  /** Set once the rider has deliberately left (cancelled, finished, minimised). */
  const [leaving, setLeaving] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const { user } = useAuth();
  const { data: trackingData } = useRideTracking(activeRideId ?? undefined);

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

  // ── Fares ───────────────────────────────────────────────────────────────────
  // The same @rida/shared pricing functions the server locks fares with
  // (createRide / switchRideType), so the prices shown here are the prices
  // charged. Shared is flat per rider regardless of occupancy.
  const sharedFare = useMemo(() => getSharedFarePerRider(1), []);
  const loneFare = useMemo(() => priceLoneRide().fare, []);
  const fareFor = useCallback((type: RideType) => (type === "SHARED" ? sharedFare : loneFare), [sharedFare, loneFare]);

  const options: RideOption[] = useMemo(
    () => [
      {
        type: "SHARED",
        title: "Shared",
        subtitle: "Up to 4 riders",
        farePesewas: sharedFare,
        priceLabel: formatCedis(sharedFare),
        recommended: true,
      },
      {
        type: "LONE",
        title: "Ride alone",
        subtitle: "Private car",
        farePesewas: loneFare,
        priceLabel: formatCedis(loneFare),
      },
    ],
    [sharedFare, loneFare],
  );
  const selectedOption = options.find((o) => o.type === selectedType) ?? options[0]!;

  // Once a ride exists, the SERVER's type is the truth (it may have been
  // switched, or this may be a resumed ride of either type).
  const rideType: RideType = ride?.type ?? selectedType;
  const priceLabel = formatCedis(fareFor(rideType));

  // ── Map coords & region ─────────────────────────────────────────────────────
  const pickupCoord = useMemo(
    () => ({ latitude: Number(params.pickupLat), longitude: Number(params.pickupLng) }),
    [params.pickupLat, params.pickupLng],
  );
  const dropoffCoord = useMemo(
    () => ({ latitude: Number(params.dropoffLat), longitude: Number(params.dropoffLng) }),
    [params.dropoffLat, params.dropoffLng],
  );

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
  const etaToPickup = useMemo(
    () => estimateEtaMinutes(driverLocation, pickupCoord),
    [driverLocation, pickupCoord],
  );
  const etaToDropoff = useMemo(
    () => estimateEtaMinutes(driverLocation, dropoffCoord),
    [driverLocation, dropoffCoord],
  );

  const region = useMemo(() => {
    const points = [pickupCoord, dropoffCoord];
    if (driverLocation) points.push(driverLocation);
    return regionForCoordinates(points, 0.8);
  }, [pickupCoord, dropoffCoord, driverLocation]);

  const mapZones = useMemo(() => {
    const zones: CampusMapZone[] = [
      { id: "pickup", ...pickupCoord, label: params.pickupZoneName, role: "pickup" },
      { id: "dropoff", ...dropoffCoord, label: params.dropoffZoneName, role: "dropoff" },
    ];
    if (driverLocation) {
      zones.push({ id: "driver", ...driverLocation, label: "Driver", role: "driver" });
    }
    return zones;
  }, [pickupCoord, dropoffCoord, driverLocation, params.pickupZoneName, params.dropoffZoneName]);

  // ── Phase ───────────────────────────────────────────────────────────────────
  const isSearching = activeRideId !== null && (!ride || ride.status === "REQUESTED" || isMerged);
  const hasDriver = ride?.status === "MATCHED" || ride?.status === "ARRIVED";

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
    if (!params.pickupZoneId || !params.dropoffZoneId) return;
    setSubmitting(true);
    try {
      const created = await createRide({
        pickupZoneId: params.pickupZoneId,
        dropoffZoneId: params.dropoffZoneId,
        type: selectedType,
        paymentMethod: selectedPaymentMethod,
      });
      setActiveRideId(created.id);
      void queryClient.invalidateQueries({ queryKey: activeRideQueryKey });
    } catch (err) {
      if (err instanceof ActiveRideExistsError) {
        // Not an error to show: offer the way to the ride that's in the way.
        await queryClient.invalidateQueries({ queryKey: activeRideQueryKey });
        setConflictOpen(true);
      } else {
        Alert.alert("Couldn't request a ride", "Please check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
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
    } catch {
      Alert.alert("Something went wrong", "Please try again.");
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
      setCancelSheetOpen(false);
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
        Alert.alert("Couldn't switch", "Please check your connection and try again.");
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
      setCancelSheetOpen(false);
      void queryClient.invalidateQueries({ queryKey: activeRideQueryKey });
      // A deliberate exit: lift the leave guard, then go (see effect below).
      setLeaving(true);
    } catch (err) {
      if (httpStatus(err) === 409) {
        await refreshRide();
        setCancelSheetOpen(false);
        Alert.alert("Can't cancel now", "This ride can no longer be cancelled.");
      } else {
        Alert.alert("Couldn't cancel", "Please check your connection and try again.");
      }
    } finally {
      setCancelling(false);
    }
  }

  /** Pops everything above the tabs, so "home" is Home even from Plan → Choose. */
  const goHome = useCallback(() => {
    if (router.canDismiss()) router.dismissAll();
    else router.replace("/");
  }, [router]);

  // ── Never lose an active ride ───────────────────────────────────────────────
  // Back arrow, iOS swipe-back and Android back all try to REMOVE this
  // screen; while a ride is going on that is intercepted. Still cancellable
  // (searching, or waiting for the driver) → the cancel sheet, so leaving is
  // a deliberate choice. On the trip → minimise to Home; the ride carries on
  // and the banner there brings the rider back.
  const leaveBehaviour = rideLeaveBehaviour({
    status: ride?.status,
    type: ride?.type ?? selectedType,
    legStatus: myPassenger?.status ?? null,
  });
  usePreventRemove(!leaving && leaveBehaviour !== "leave", () => {
    if (leaveBehaviour === "minimise") setLeaving(true);
    else setCancelSheetOpen(true);
  });
  useEffect(() => {
    // Runs after the render that switched the guard off, so the pop is allowed.
    if (leaving) goHome();
  }, [leaving, goHome]);

  // "Cancel it" from Choose a ride lands here with openCancel=1.
  const autoOpenedCancel = useRef(false);
  useEffect(() => {
    if (!params.openCancel || autoOpenedCancel.current || !ride) return;
    autoOpenedCancel.current = true;
    if (leaveBehaviour === "confirm") setCancelSheetOpen(true);
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
  // The sheet reports its height whenever it settles, so the map re-fits
  // when the sheet grows or shrinks.
  const [sheetHeight, setSheetHeight] = useState(inOptions ? OPTIONS_SHEET_ESTIMATE : windowHeight * 0.55);
  const onSheetChange = useCallback(
    (_index: number, position: number) => {
      if (position > 0) setSheetHeight(Math.round(windowHeight - position));
    },
    [windowHeight],
  );
  const hasDriverPin = driverLocation !== null;
  const fitTo = useMemo(
    () => (hasDriverPin && driverLocation ? [pickupCoord, dropoffCoord, driverLocation] : [pickupCoord, dropoffCoord]),
    // Re-fit when the driver first appears, not on every GPS ping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pickupCoord, dropoffCoord, hasDriverPin],
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
      params: { pickupZoneId: params.pickupZoneId, dropoffZoneId: params.dropoffZoneId },
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
        routeLine={[pickupCoord, dropoffCoord]}
        height={windowHeight}
        light
        showRecenter
        rounded={false}
        pulseZoneId={isSearching ? "pickup" : undefined}
        fitTo={fitTo}
        fitPadding={fitPadding}
        controlsBottomInset={sheetHeight}
      />

      <RoutePill
        top={insets.top + PILL_TOP_GAP}
        pickupZoneName={params.pickupZoneName}
        dropoffZoneName={params.dropoffZoneName}
        onBack={goBack}
        // A requested ride's route can't change, so Edit only exists before.
        onEdit={inOptions ? editRoute : undefined}
      />

      {inOptions ? (
        // Sized to its content (no fixed snap points), so the Cash + Request
        // bar is always the last thing in view and nothing sits behind it.
        <BottomSheet
          key="options"
          index={0}
          enableDynamicSizing
          maxDynamicContentSize={windowHeight * 0.85}
          onChange={onSheetChange}
          backgroundStyle={styles.sheetBackground}
          handleIndicatorStyle={styles.sheetHandle}
        >
          <BottomSheetView style={[styles.optionsSheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
            <Text variant="h3" accessibilityRole="header" style={styles.optionsTitle}>
              Choose a ride
            </Text>
            <View style={styles.optionList} accessibilityRole="radiogroup" accessibilityLabel="Choose a ride">
              {options.map((option) => (
                <RideOptionCard
                  key={option.type}
                  option={option}
                  selected={selectedType === option.type}
                  onSelect={() => {
                    if (option.type !== selectedType) haptics.selection();
                    setSelectedType(option.type);
                  }}
                />
              ))}
            </View>

            <View style={styles.requestBar}>
              {/* Cash-only launch (Phase 1): MoMo is intentionally not
                  offered — a MOMO ride couldn't be settled while digital
                  payment is off server-side. A statement, not a picker. */}
              <View
                style={styles.cash}
                accessible
                accessibilityLabel="Payment: cash. Pay your driver at the end of the trip."
              >
                <Ionicons name="cash-outline" size={20} color={colors.primary[500]} />
                <Text variant="bodyMedium" style={styles.cashText}>
                  Cash
                </Text>
              </View>
              <View style={styles.requestButton}>
                <Button
                  label={`Request ${selectedOption.title}`}
                  size="lg"
                  onPress={() => void handleSubmit()}
                  loading={submitting}
                  accessibilityHint={`${spokenCedis(selectedOption.farePesewas)}, paid in cash`}
                />
              </View>
            </View>
          </BottomSheetView>
        </BottomSheet>
      ) : (
      <BottomSheet
        key="tracking"
        snapPoints={["55%", "90%"]}
        index={0}
        onChange={onSheetChange}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.sheetHandle}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
      >
        <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
          {resumingUnloaded ? (
            <SkeletonGroup label="Loading your ride" style={styles.resumeSkeleton}>
              <Skeleton width={120} height={120} radius={radii.full} style={styles.centerSelf} />
              <Skeleton width="60%" height={24} style={styles.centerSelf} />
              <Skeleton width="80%" height={14} style={styles.centerSelf} />
              <Skeleton height={120} radius={radii.lg} />
            </SkeletonGroup>
          ) : activeRideId !== null &&
            (myPassenger?.status === "CANCELLED" ? (
              <CancelledContent
                onDone={() => setLeaving(true)}
                title="Driver cancelled"
                message="Your driver cancelled your pickup. Please request a ride again."
              />
            ) : (
            <>
              {isSearching && (
                <FadeIn key="searching">
                  <SearchingPanel
                    pickupZoneName={params.pickupZoneName}
                    dropoffZoneName={params.dropoffZoneName}
                    rideType={rideType}
                    priceLabel={priceLabel}
                    broadcastStartedAt={ride?.broadcastStartedAt}
                    onCancel={() => setCancelSheetOpen(true)}
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
                    onCancel={() => setCancelSheetOpen(true)}
                  />
                </FadeIn>
              )}

              {(ride?.status === "MATCHED" ||
                ride?.status === "ARRIVED" ||
                ride?.status === "IN_PROGRESS") &&
                driver &&
                (myLegStatus === "DROPPED_OFF" ? (
                  <FadeIn key="leg-done">
                    <MyLegDoneContent dropoffZoneName={params.dropoffZoneName} />
                  </FadeIn>
                ) : myLegStatus === "PICKED_UP" ? (
                  <FadeIn key="in-progress">
                    <InProgressContent
                      driver={driver}
                      dropoffZoneName={params.dropoffZoneName}
                      etaMinutes={etaToDropoff}
                      rideId={ride.id}
                    />
                  </FadeIn>
                ) : (
                  <FadeIn key="driver-found">
                    <DriverFoundContent
                      arrived={myLegStatus === "ARRIVED"}
                      driver={driver}
                      hasLocation={!!driverLocation}
                      etaMinutes={etaToPickup}
                      rideId={ride.id}
                      onCancel={() => setCancelSheetOpen(true)}
                    />
                  </FadeIn>
                ))}

              {ride?.status === "COMPLETED" && (
                <FadeIn key="completed">
                  <CompletedContent
                    rideId={ride.id}
                    rideType={ride.type}
                    fareSummary={trackingData?.fareSummary}
                    onDone={() => setLeaving(true)}
                  />
                </FadeIn>
              )}

              {ride?.status === "CANCELLED" && !isMerged && (
                <CancelledContent onDone={() => setLeaving(true)} />
              )}
            </>
            ))}
        </BottomSheetScrollView>
      </BottomSheet>
      )}

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
        <CancelRideSheet
          visible={cancelSheetOpen}
          stage={hasDriver ? "driver_assigned" : "searching"}
          switchOffer={switchOffer}
          switching={switching}
          cancelling={cancelling}
          onDismiss={() => setCancelSheetOpen(false)}
          onSwitch={(toType) => void handleSwitch(toType, "sheet")}
          onConfirmCancel={(reason, note) => void handleConfirmCancel(reason, note)}
        />
      ) : null}
    </View>
  );
}

// ── Route pill ────────────────────────────────────────────────────────────────

/**
 * Floats over the top of the map: back · "Pickup → Drop-off" · Edit. Takes
 * the place of the route text that used to sit inside the sheet.
 */
function RoutePill({
  top,
  pickupZoneName,
  dropoffZoneName,
  onBack,
  onEdit,
}: {
  top: number;
  pickupZoneName: string;
  dropoffZoneName: string;
  onBack: () => void;
  onEdit?: () => void;
}) {
  return (
    <View style={[styles.pill, { top }]}>
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={6} style={styles.pillBack}>
        <Ionicons name="arrow-back" size={22} color={colors.ink[900]} />
      </Pressable>
      <Text
        variant="bodyMedium"
        numberOfLines={1}
        style={styles.pillRoute}
        accessibilityLabel={`From ${pickupZoneName} to ${dropoffZoneName}`}
      >
        {pickupZoneName} → {dropoffZoneName}
      </Text>
      {onEdit ? (
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel="Edit route"
          hitSlop={6}
          style={styles.pillEdit}
        >
          <Text variant="bodyMedium" color="primary" style={styles.pillEditText}>
            Edit
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── Tracking phase content ────────────────────────────────────────────────────

function DriverAvatar({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  const showPhoto = Boolean(photoUrl) && !failed;
  return (
    <View style={styles.avatar} accessibilityLabel={`Driver ${name}`}>
      {showPhoto ? (
        <Image
          source={{ uri: cloudinaryAvatar(photoUrl!, 48) }}
          style={styles.avatarImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={200}
          onError={() => setFailed(true)}
        />
      ) : (
        <Text variant="h3" color="inverse">
          {initials}
        </Text>
      )}
    </View>
  );
}

function PremiumDriverCard({ driver }: { driver: RideDriverInfo }) {
  const car = [driver.carColor, driver.carMake, driver.carModel].filter(Boolean).join(" ");
  return (
    <Card style={styles.driverCard}>
      <View style={styles.driverRow}>
        <DriverAvatar name={driver.name} photoUrl={driver.photoUrl} />
        <View style={styles.driverInfo}>
          <Text variant="h3">{driver.name}</Text>
          {driver.rating != null && (
            <View style={styles.ratingRow}>
              <Ionicons name="star" size={13} color={colors.accent[500]} />
              <Text variant="bodySmall" color="muted">
                {" "}
                {driver.rating.toFixed(1)}
              </Text>
            </View>
          )}
          {car ? (
            <Text variant="bodySmall" color="muted">
              {car}
            </Text>
          ) : null}
        </View>
        {driver.plate ? (
          <View style={styles.plateBadge}>
            <Text variant="mono" style={styles.plateText}>{driver.plate}</Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * Phase 4: the actions a rider needs while a ride is live — reach the driver,
 * or raise an alarm. Rendered in every in-ride state (driver assigned, en
 * route, on the trip) so its position never moves; a safety control that
 * relocates between screens is one the rider has to hunt for.
 */
function RideSafetyActions({ rideId, driver }: { rideId: string; driver: RideDriverInfo }) {
  const [sending, setSending] = useState(false);

  function confirmSos() {
    Alert.alert(
      "Send an SOS?",
      "We'll text your emergency contact where you are, who your driver is, and a link to follow this trip.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Send SOS",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setSending(true);
              try {
                const result = await raiseSos(rideId);

                // Report exactly who was actually reached, rather than a
                // blanket "sent" — in an emergency the difference matters.
                const reached: string[] = [];
                if (result.smsDelivered && result.contactName) reached.push(result.contactName);
                if (result.supportNotified) reached.push("CampusRide support");

                if (reached.length > 0) {
                  const nudge = result.hasEmergencyContact
                    ? ""
                    : "\n\nAdd an emergency contact in Account → Safety so someone you know is alerted too.";
                  Alert.alert(
                    "SOS sent",
                    `${reached.join(" and ")} ${reached.length === 1 ? "has" : "have"} been sent a link to follow your trip.${nudge}`,
                  );
                } else {
                  // Nothing got through — hand over the link so the rider can
                  // still get help through some other channel.
                  Alert.alert(
                    "SOS raised, but we couldn't send a message",
                    `Share this link with someone you trust, or call them directly:\n\n${result.trackingUrl}`,
                  );
                }
              } catch {
                Alert.alert("Couldn't send SOS", "Please try again, or call someone directly.");
              } finally {
                setSending(false);
              }
            })();
          },
        },
      ],
    );
  }

  return (
    <View style={styles.safetyRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Call ${driver.name}`}
        onPress={() => void callPhone(driver.phone, driver.name)}
        style={styles.callButton}
      >
        <Ionicons name="call" size={18} color={colors.primary[500]} />
        <Text variant="bodySmall" color="primary">
          Call driver
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send an emergency SOS"
        onPress={confirmSos}
        disabled={sending}
        style={[styles.sosButton, sending && styles.sosButtonBusy]}
      >
        <Ionicons name="alert-circle" size={18} color={colors.surface} />
        <Text variant="bodySmall" color="inverse">
          {sending ? "Sending…" : "SOS"}
        </Text>
      </Pressable>
    </View>
  );
}

function DriverFoundContent({
  arrived,
  driver,
  hasLocation,
  etaMinutes,
  rideId,
  onCancel,
}: {
  /** Ride-level ARRIVED (LONE) OR this rider's own passenger row is ARRIVED
   * (SHARED, Phase 6b-3 — the ride itself may still be MATCHED if this
   * passenger's pickup is the car's first). */
  arrived: boolean;
  driver: RideDriverInfo;
  hasLocation: boolean;
  /** Minutes until the driver reaches the pickup point, or null if unknown. */
  etaMinutes: number | null;
  rideId: string;
  /** Opens the cancel sheet (reason required). */
  onCancel: () => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon
          name={arrived ? "flag" : "car"}
          size={48}
          iconSize={22}
          background={arrived ? colors.successSurface : colors.primary[50]}
          color={arrived ? colors.success : colors.primary[500]}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">{arrived ? "Your driver has arrived" : "Driver is on the way to you"}</Text>
          <Text variant="bodySmall" color="muted">
            {arrived
              ? "Head to your pickup point — your driver is waiting."
              : hasLocation
                ? `${formatEta(etaMinutes)} away`
                : "Your driver is getting ready"}
          </Text>
        </View>
      </View>

      <PremiumDriverCard driver={driver} />

      <RideSafetyActions rideId={rideId} driver={driver} />

      <Button label="Cancel ride" variant="secondary" onPress={onCancel} />
    </View>
  );
}

function InProgressContent({
  driver,
  dropoffZoneName,
  etaMinutes,
  rideId,
}: {
  driver: RideDriverInfo;
  dropoffZoneName: string;
  /** Minutes until the dropoff point, or null if the driver's location is unknown. */
  etaMinutes: number | null;
  rideId: string;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon name="navigate" size={48} iconSize={22} />
        <View style={styles.stateHeading}>
          <Text variant="h2">On your way</Text>
          <Text variant="bodySmall" color="muted">
            Heading to {dropoffZoneName} · {formatEta(etaMinutes)}
          </Text>
        </View>
      </View>

      <PremiumDriverCard driver={driver} />

      <RideSafetyActions rideId={rideId} driver={driver} />
    </View>
  );
}

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
        <ServiceIcon
          name="checkmark-circle"
          size={48}
          iconSize={22}
          background={colors.successSurface}
          color={colors.success}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">You're at {dropoffZoneName}</Text>
          <Text variant="bodySmall" color="muted">
            Wrapping up the rest of the trip — your fare summary will appear shortly.
          </Text>
        </View>
      </View>
    </View>
  );
}

function RatingPanel({
  rideId,
  onDone,
}: {
  rideId: string;
  onDone: () => void;
}) {
  const [stars, setStars] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit() {
    if (stars === 0) return;
    setSubmitting(true);
    try {
      await submitRating({ rideId, stars });
      setSubmitted(true);
    } catch {
      Alert.alert("Couldn't submit rating", "Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <>
        <Text variant="body" color="muted">
          Thanks for rating your driver!
        </Text>
        <Button label="Back to home" onPress={onDone} />
      </>
    );
  }

  return (
    <>
      <View style={styles.ratingSection}>
        <Text variant="bodyMedium">How was your ride?</Text>
        <View style={styles.starsRow}>
          {STARS.map((value) => (
            <Pressable key={value} accessibilityRole="button" onPress={() => setStars(value)}>
              <Ionicons
                name={value <= stars ? "star" : "star-outline"}
                size={36}
                color={value <= stars ? colors.accent[500] : colors.ink[200]}
              />
            </Pressable>
          ))}
        </View>
      </View>
      <View style={styles.buttonGroup}>
        <Button
          label="Submit rating"
          onPress={() => void handleSubmit()}
          loading={submitting}
          disabled={stars === 0}
        />
        <Button label="Skip" variant="ghost" onPress={onDone} />
      </View>
    </>
  );
}

/** Mint "shared & saved" note — purely presentational, derived from the existing flat lone-fare constant. */
function SharedSavingsNote({ amountPesewas }: { amountPesewas: number }) {
  return (
    <View style={styles.savingsNote}>
      <Ionicons name="people" size={14} color={colors.success} />
      <Text variant="bodySmall" style={styles.savingsNoteText}>
        Shared ride — you saved {formatCedis(amountPesewas)} vs. lone
      </Text>
    </View>
  );
}

/**
 * Ride-complete state. Cash-only launch (Phase 1): digital payment is
 * disabled server-side, so there is no "Pay with MoMo" trigger here and this
 * screen never calls POST /rides/:id/initiate-payment. Every completed ride
 * is settled in cash directly with the driver; the rider goes straight from
 * the fare summary to rating.
 */
function CompletedContent({
  rideId,
  rideType,
  fareSummary,
  onDone,
}: {
  rideId: string;
  rideType: RideType;
  fareSummary: RideCompletedFareSummary | undefined;
  onDone: () => void;
}) {
  const [ratingReady, setRatingReady] = useState(false);

  if (!fareSummary) {
    return (
      <View style={styles.section}>
        <LoadingState />
      </View>
    );
  }

  const { yourFarePesewas } = fareSummary;
  const savingsPesewas =
    rideType === "SHARED" ? Math.max(0, priceLoneRide().fare - yourFarePesewas) : 0;

  if (ratingReady) {
    return (
      <View style={styles.section}>
        <View style={styles.stateHeader}>
          <ServiceIcon
            name="checkmark-circle"
            size={48}
            iconSize={22}
            background={colors.successSurface}
            color={colors.success}
          />
          <View style={styles.stateHeading}>
            <Text variant="h2">Ride completed</Text>
          </View>
        </View>
        <RatingPanel rideId={rideId} onDone={onDone} />
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon
          name="checkmark-circle"
          size={48}
          iconSize={22}
          background={colors.successSurface}
          color={colors.success}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">Ride completed</Text>
          <Text variant="bodySmall" color="muted">
            Your fare: {formatCedis(yourFarePesewas)}
          </Text>
        </View>
      </View>
      {savingsPesewas > 0 && <SharedSavingsNote amountPesewas={savingsPesewas} />}
      <Card style={styles.infoCard}>
        <View style={styles.infoRow}>
          <Ionicons name="cash-outline" size={16} color={colors.ink[400]} />
          <Text variant="bodySmall" style={styles.infoLabel}>
            Please pay {formatCedis(yourFarePesewas)} to your driver in cash.
          </Text>
        </View>
      </Card>
      <Button label="Done — rate your driver" onPress={() => setRatingReady(true)} />
    </View>
  );
}

function CancelledContent({
  onDone,
  title = "Ride cancelled",
  message = "Your request has been cancelled.",
}: {
  onDone: () => void;
  title?: string;
  message?: string;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.stateHeader}>
        <ServiceIcon
          name="close-circle"
          size={48}
          iconSize={22}
          background={colors.errorSurface}
          color={colors.error}
        />
        <View style={styles.stateHeading}>
          <Text variant="h2">{title}</Text>
          <Text variant="bodySmall" color="muted">
            {message}
          </Text>
        </View>
      </View>
      <Button label="Back to home" variant="secondary" onPress={onDone} />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Phase 4: in-ride safety + contact row.
  safetyRow: { flexDirection: "row", gap: spacing.sm },
  callButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.primary[500],
    backgroundColor: colors.primary[50],
  },
  sosButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.error,
  },
  sosButtonBusy: { opacity: 0.6 },
  container: { flex: 1 },
  sheetBackground: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
  },
  sheetHandle: { backgroundColor: colors.borderStrong, width: 40, height: 5 },
  sheetContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  // ── Options
  optionsSheet: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: spacing.md },
  optionsTitle: { paddingHorizontal: spacing.xs, marginBottom: -spacing.xs },
  optionList: { gap: spacing.xs },
  requestBar: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  cash: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.xs },
  cashText: { fontWeight: typography.weight.semibold },
  requestButton: { flex: 1 },
  // ── Route pill
  pill: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    height: PILL_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingLeft: spacing.xs,
    paddingRight: spacing.sm,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    ...shadows.md,
  },
  pillBack: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  pillRoute: { flex: 1, fontWeight: typography.weight.semibold },
  pillEdit: { minHeight: 40, justifyContent: "center", paddingHorizontal: spacing.sm },
  pillEditText: { fontWeight: typography.weight.bold },
  resumeSkeleton: { gap: spacing.lg, paddingTop: spacing.md },
  centerSelf: { alignSelf: "center" },
  // ── State panels
  section: { gap: spacing.md },
  stateHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  stateHeading: { flex: 1, gap: 4 },
  savingsNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.successSurface,
    borderWidth: 1,
    borderColor: colors.primary[100],
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  savingsNoteText: { flex: 1, color: colors.success, fontWeight: typography.weight.semibold },
  infoCard: { gap: spacing.sm },
  infoRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  infoLabel: { flex: 1 },
  buttonGroup: { gap: spacing.md },
  // ── Driver card
  driverCard: {},
  driverRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  driverInfo: { flex: 1, gap: 2 },
  ratingRow: { flexDirection: "row", alignItems: "center" },
  // 14pt: the plate is what a rider checks before getting in.
  plateText: { fontSize: typography.size.sm },
  plateBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.sm,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImage: {
    width: 48,
    height: 48,
    borderRadius: radii.full,
  },
  // ── Rating
  ratingSection: { alignItems: "center", gap: spacing.sm },
  starsRow: { flexDirection: "row", gap: spacing.sm },
});
