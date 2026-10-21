import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsFocused, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  CAR_SEATS,
  CLAIM_NETWORK_MESSAGE,
  DRIVER_EVENTS,
  LOCATION_PROBLEM_MESSAGE,
  SERVICE_AREA_POLYGON,
  cloudinaryAvatar,
  filterRequestsByType,
  getSharedFarePerRider,
  sortRequestsNearestFirst,
  todayEarnings,
  type LatLng,
  type RequestTypeFilter,
} from "@rida/shared";
import {
  BottomSheet,
  Button,
  CampusMapView,
  Chip,
  LoadingState,
  Notice,
  Screen,
  StatusChip,
  Text,
  colors,
  formatCedis,
  getDriverRideHistory,
  getFillSuggestions,
  getRideSocket,
  haptics,
  radii,
  regionForCoordinates,
  shadows,
  spacing,
  useAuth,
  useToast,
  type EligibleRideItem,
  type RideWithZones,
} from "@rida/mobile-shared";
import {
  markTripOpened,
  tripHref,
  tripStatusLine,
  useDriverActiveTrip,
  wasTripOpened,
} from "../../lib/activeTrip";
import { useDriverLocation } from "../../lib/location";
import { useDriverPresence } from "../../lib/presence";
import { useRequestsNearYou } from "../../lib/requests";
import {
  acceptRequest,
  overlayPassengers,
  runAddRider,
  useTripActions,
} from "../../lib/tripActions";
import { useZones } from "../../lib/zones";
import { RequestCard, type HomeRequest } from "../../components/home/RequestCard";
import { OfferTakeover } from "../../components/offers/OfferTakeover";
import { useOfferQueue } from "../../lib/offers";

const FILTERS: { value: RequestTypeFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "SHARED", label: "Shared" },
  { value: "LONE", label: "Private" },
];

/** The whole campus: the map's view before we know where the car is. */
const CAMPUS_REGION = regionForCoordinates(
  SERVICE_AREA_POLYGON.map(([latitude, longitude]) => ({ latitude, longitude })),
  0.05,
);
/** Around the car: a few streets. */
const NEARBY_DELTA = 0.008;
/** Before the sheet reports its height. */
const SHEET_ESTIMATE = 220;
/** The Go online pill (64) and its gap above the sheet. */
const GO_ONLINE_BLOCK = 64 + spacing[4];
/** The earnings history is shared with the Earnings tab (same cache entry). */
const HISTORY_QUERY_KEY = ["driverRideHistory"];

/**
 * Home, map-first (docs/mockups/08-driver-home-offline.png and
 * 09-driver-home-online.png): the car on the map, the account button and
 * today's earnings floating on top, and a sheet at the bottom.
 *
 * - Offline: "You're offline" in a short sheet, and the green Go online
 *   pill above it.
 * - Online and free: the car pulses; the sheet says it's looking, with the
 *   All / Shared / Private chips, Go offline, and every request near you
 *   (nearest first, Accept opens the trip at once — lib/tripActions). New
 *   requests also open full screen (OfferTakeover).
 * - On a trip: a dark row at the top of the sheet opens it. On a Shared trip,
 *   riders who fit the route, each with See route and Add.
 *
 * The list updates live (new requests arrive over the socket; it also polls),
 * and a request you accept or add leaves the list the moment you tap.
 */
export default function DriverHomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { isLoading: authLoading, user } = useAuth();
  const { isOnline, waking, outsideServiceArea, position, locationProblem, toggle } =
    useDriverPresence();
  const location = useDriverLocation();
  const { data: trip, isLoading: tripLoading } = useDriverActiveTrip();
  const actions = useTripActions();
  const { data: zones = [] } = useZones();
  const [filter, setFilter] = useState<RequestTypeFilter>("ALL");
  const [areaHeight, setAreaHeight] = useState(windowHeight);
  const [sheetCover, setSheetCover] = useState(SHEET_ESTIMATE);
  const focused = useIsFocused();

  // Open a trip's screen once per trip (one started elsewhere, or the app
  // reopened mid-trip). After that, the dark row in the sheet leads back.
  useEffect(() => {
    if (!trip || wasTripOpened(trip.id)) return;
    markTripOpened(trip.id);
    router.push(`/ride/${trip.id}`);
  }, [trip, router]);

  // ─── Where the car is ───────────────────────────────────────────────────
  // Online, the live position. Offline, location isn't tracked (no GPS, no
  // "You're online" notification), so the car sits at the last fix the
  // phone already has, looked up whenever Home comes into view.
  const [lastFix, setLastFix] = useState<LatLng | null>(null);
  const { currentOrLastKnown } = location;
  useEffect(() => {
    if (!focused) return;
    let alive = true;
    void currentOrLastKnown().then((fix) => alive && fix && setLastFix(fix));
    return () => {
      alive = false;
    };
  }, [focused, isOnline, currentOrLastKnown]);
  const car = position ?? location.position ?? lastFix;

  // ─── Today's earnings ───────────────────────────────────────────────────
  // GET /driver/rides/history has no "today" total, so it's the sum of the
  // driver's share of today's completed trips (todayEarnings).
  const history = useQuery({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: getDriverRideHistory,
    enabled: Boolean(user),
  });
  const { refetch: refetchHistory } = history;
  useEffect(() => {
    // A trip finished elsewhere: fresh numbers each time Home is shown.
    if (focused) void refetchHistory();
  }, [focused, refetchHistory]);
  const today = history.data ? todayEarnings(history.data.rides) : null;

  // ─── Requests when free ─────────────────────────────────────────────────
  const free = isOnline && !trip;
  const eligible = useRequestsNearYou(free, position);

  // ─── Riders who fit a shared trip ───────────────────────────────────────
  const sharedTrip =
    trip?.type === "SHARED" &&
    (trip.status === "MATCHED" || trip.status === "ARRIVED" || trip.status === "IN_PROGRESS")
      ? trip
      : null;
  const seated = sharedTrip
    ? overlayPassengers(sharedTrip.id, sharedTrip.passengers).filter(
        (p) => p.status === "WAITING" || p.status === "ARRIVED" || p.status === "PICKED_UP",
      ).length
    : 0;
  const freeSeats = Math.max(0, CAR_SEATS - seated);
  const fill = useQuery({
    queryKey: ["fillSuggestions", sharedTrip?.id],
    queryFn: () => getFillSuggestions(sharedTrip!.id),
    enabled: Boolean(sharedTrip) && freeSeats > 0,
    refetchInterval: 10_000,
  });
  const { refetch: refetchFill } = fill;
  useEffect(() => {
    if (!sharedTrip) return;
    const socket = getRideSocket();
    const onBroadcast = () => void refetchFill();
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [sharedTrip, refetchFill]);

  const sharedFare = getSharedFarePerRider(1);
  const items: HomeRequest[] = useMemo(() => {
    if (free) {
      const open = (eligible.data ?? []).filter((r) => r.rideId !== actions.claim?.rideId);
      // The server's distance to each pickup's named place when it sends one
      // (the same number the offer pop-up shows); else from the zone centre.
      const measured = sortRequestsNearestFirst(open, position, zones).map((r) => ({
        ...r,
        distanceMeters: r.pickupDistanceMeters ?? r.distanceMeters,
      }));
      measured.sort((a, b) =>
        a.distanceMeters !== null &&
        b.distanceMeters !== null &&
        a.distanceMeters !== b.distanceMeters
          ? a.distanceMeters - b.distanceMeters
          : 0,
      );
      return filterRequestsByType(measured, filter);
    }
    if (sharedTrip && freeSeats > 0) {
      const fits = (fill.data?.suggestions ?? [])
        .filter((s) => s.compatible && !actions.adds[s.requestRideId])
        .map((s) => ({
          rideId: s.requestRideId,
          type: "SHARED" as const,
          seats: 1,
          farePesewas: sharedFare,
          pickupZoneId: s.pickupZoneId,
          pickupZoneName: s.pickupZoneName,
          dropoffZoneName: s.dropoffZoneName,
          pickupPlaceName: s.pickupPlaceName,
          dropoffPlaceName: s.dropoffPlaceName,
          createdAt: s.createdAt,
          riderFirstName: s.riderFirstName,
        }));
      return sortRequestsNearestFirst(fits, position, zones);
    }
    return [];
  }, [
    free,
    eligible.data,
    actions.claim,
    actions.adds,
    position,
    zones,
    filter,
    sharedTrip,
    freeSeats,
    fill.data,
    sharedFare,
  ]);

  // ─── Accept (the offer's, or a request card's) ──────────────────────────
  // One flow for both (lib/tripActions acceptRequest): a spinner while the
  // server answers, then the trip — or a toast that the request was taken
  // or expired, or "Couldn't reach CampusRide" with Try again.
  const { showToast, toast } = useToast();
  const [accepting, setAccepting] = useState<{ rideId: string; fromOffer: boolean } | null>(null);
  const [acceptError, setAcceptError] = useState<{ rideId: string; message: string } | null>(null);
  const acceptingRef = useRef(false);
  const offersRef = useRef<ReturnType<typeof useOfferQueue> | null>(null);
  const { refetch: refetchEligible } = eligible;
  const runAccept = useCallback(
    async (request: EligibleRideItem, fromOffer: boolean) => {
      if (acceptingRef.current) return;
      acceptingRef.current = true;
      setAccepting({ rideId: request.rideId, fromOffer });
      setAcceptError(null);
      const outcome = await acceptRequest(request);
      acceptingRef.current = false;
      setAccepting(null);
      if (outcome.kind === "accepted") {
        haptics.success();
        offersRef.current?.markHandled(request.rideId);
        markTripOpened(request.rideId);
        router.push(`/ride/${request.rideId}`);
      } else if (outcome.kind === "gone") {
        // Closes the offer (if it's this one) with the toast; never offered again.
        offersRef.current?.closeGone(request.rideId, outcome.reason);
        void refetchEligible();
      } else {
        setAcceptError({
          rideId: request.rideId,
          message: outcome.kind === "network" ? CLAIM_NETWORK_MESSAGE : outcome.message,
        });
      }
    },
    [router, refetchEligible],
  );

  // ─── Offer takeovers (one at a time, nearest first) ─────────────────────
  // Over Home only, while it's on screen, online and free — and not while a
  // request card's accept is on its way.
  const offers = useOfferQueue({
    enabled: free && focused && !(accepting && !accepting.fromOffer),
    items: eligible.data ?? [],
    onAccept: (request) => void runAccept(request, true),
  });
  offersRef.current = offers;

  // An offer that went away (taken, cancelled, expired): a toast.
  const { notice } = offers;
  useEffect(() => {
    if (notice) showToast({ message: notice, tone: "info", icon: "information-circle" });
  }, [notice, showToast]);

  // A card's error belongs to that request: gone from the list, gone from here.
  const listError =
    acceptError && acceptError.rideId !== offers.offer?.item.rideId
      ? (eligible.data ?? []).find((r) => r.rideId === acceptError.rideId)
      : undefined;

  if (authLoading || tripLoading || !user) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const accept = (item: HomeRequest) => {
    const request = eligible.data?.find((r) => r.rideId === item.rideId);
    if (request) void runAccept(request, false);
  };
  const add = (item: HomeRequest) => {
    const suggestion = fill.data?.suggestions.find((s) => s.requestRideId === item.rideId);
    if (!sharedTrip || !suggestion) return;
    runAddRider(sharedTrip.id, suggestion, sharedFare, position);
  };
  const goOnline = () => {
    haptics.impactMedium();
    toggle();
  };

  const region = car
    ? { ...car, latitudeDelta: NEARBY_DELTA, longitudeDelta: NEARBY_DELTA }
    : CAMPUS_REGION;
  const listed = items.length > 0;

  return (
    <View style={styles.root} onLayout={(e) => setAreaHeight(e.nativeEvent.layout.height)}>
      <CampusMapView
        // A new view when we learn where the car is.
        key={car ? "car" : "campus"}
        initialRegion={region}
        zones={car ? [{ id: "car", ...car, label: "You", role: "driver" }] : []}
        // Looking for trips: the same pulse as a rider's pickup while searching.
        pulseZoneId={free && car ? "car" : undefined}
        height={areaHeight}
        light
        rounded={false}
        showRecenter
        recenterLabel={car ? "Recentre on your car" : "Show the whole campus"}
        controlsBottomInset={sheetCover + (isOnline ? 0 : GO_ONLINE_BLOCK)}
      />

      <View style={[styles.topBar, { top: insets.top + spacing[2] }]} pointerEvents="box-none">
        <AccountButton
          name={user.name}
          photoUrl={user.driver?.photoUrl ?? null}
          onPress={() => router.navigate("/account")}
        />
        {today ? (
          <TodayPill
            pesewas={today.pesewas}
            trips={today.trips}
            dark={isOnline}
            onPress={() => router.navigate("/rides")}
          />
        ) : null}
        {/* Balances the account button, so the pill sits in the middle. */}
        <View style={styles.topBarEnd} />
      </View>

      {!isOnline ? (
        <View style={[styles.goOnline, { bottom: sheetCover + spacing[4] }]}>
          <Button
            label="Go online"
            icon="power"
            size="go"
            fullWidth
            onPress={goOnline}
            accessibilityHint="Start getting ride requests around campus"
          />
        </View>
      ) : null}

      <BottomSheet
        // Short while offline or quiet; with requests it opens to a list that
        // can be pulled up.
        key={!isOnline ? "offline" : listed ? "list" : "online"}
        snapPoints={isOnline && listed ? ["45%", "88%"] : undefined}
        maxHeightRatio={0.88}
        scrollable={isOnline && listed}
        contentStyle={styles.sheet}
        onChange={(_index, top) => {
          if (top > 0) setSheetCover(Math.round(areaHeight - top));
        }}
        accessibilityLabel={isOnline ? "Trips near you" : "You're offline"}
      >
        {trip ? <TripRow trip={trip} onPress={() => router.push(tripHref(trip))} /> : null}

        {!isOnline && locationProblem ? (
          <View style={styles.problem}>
            <Notice
              tone="error"
              icon="location-outline"
              message={LOCATION_PROBLEM_MESSAGE[locationProblem]}
            />
            <Button
              label="Open Settings"
              variant="secondary"
              size="md"
              onPress={() => void Linking.openSettings()}
            />
          </View>
        ) : null}

        {!isOnline ? (
          <View style={styles.heading}>
            <View style={styles.offlineTitle}>
              <View style={styles.offlineDot} />
              <Text variant="title2" accessibilityRole="header">
                You&apos;re offline
              </Text>
            </View>
            <Text variant="body" color="secondary">
              Go online to start getting ride requests around campus. Your location is shared only
              while you&apos;re online.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.heading}>
              <StatusChip label="Online" tone="brand" icon="ellipse" style={styles.onlineChip} />
              <OnlineHeading
                free={free}
                trip={trip ?? null}
                freeSeats={freeSeats}
                hasRiders={Boolean(sharedTrip) && listed}
              />
            </View>

            {/* One row: the filters scroll sideways on a narrow phone, Go offline stays put. */}
            <View style={styles.controls}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.filters}
                contentContainerStyle={styles.filtersContent}
              >
                {free && !outsideServiceArea
                  ? FILTERS.map(({ value, label }) => (
                      <Chip
                        key={value}
                        kind="filter"
                        label={label}
                        selected={value === filter}
                        onPress={() => setFilter(value)}
                        accessibilityLabel={`Show ${label.toLowerCase()} requests`}
                      />
                    ))
                  : null}
              </ScrollView>
              <Button
                label="Go offline"
                icon="power"
                variant="neutral"
                size="pill"
                onPress={toggle}
                accessibilityHint="Stop getting ride requests"
              />
            </View>

            {waking ? (
              <Text variant="subhead" color="secondary" accessibilityLiveRegion="polite">
                Connecting to CampusRide… this can take a few seconds.
              </Text>
            ) : null}

            {outsideServiceArea ? (
              <Notice
                tone="warning"
                icon="navigate-outline"
                message="You're outside the CampusRide area. Requests reach drivers within 2 km of campus: head back towards campus."
              />
            ) : null}

            {listError ? (
              <View style={styles.problem}>
                <Notice tone="error" icon="cloud-offline-outline" message={acceptError!.message} />
                <Button
                  label="Try again"
                  variant="secondary"
                  size="md"
                  onPress={() => void runAccept(listError, false)}
                />
              </View>
            ) : null}

            {items.map((item) =>
              free ? (
                <RequestCard
                  key={item.rideId}
                  item={item}
                  accepting={accepting?.rideId === item.rideId}
                  onAccept={() => accept(item)}
                />
              ) : (
                <RequestCard
                  key={item.rideId}
                  item={item}
                  onSeeRoute={() =>
                    sharedTrip && router.push(`/ride/${sharedTrip.id}?preview=${item.rideId}`)
                  }
                  onAdd={() => add(item)}
                />
              ),
            )}
          </>
        )}
      </BottomSheet>

      {offers.offer ? (
        <OfferTakeover
          key={offers.offer.item.rideId}
          offer={offers.offer}
          waiting={offers.waiting}
          car={car}
          zones={zones}
          accepting={accepting?.rideId === offers.offer.item.rideId}
          error={acceptError?.rideId === offers.offer.item.rideId ? acceptError.message : null}
          onAccept={offers.accept}
          onDecline={() => {
            setAcceptError(null);
            offers.decline();
          }}
        />
      ) : null}

      {toast}
    </View>
  );
}

/** What the online sheet says under the chip: looking, or what the trip allows. */
function OnlineHeading({
  free,
  trip,
  freeSeats,
  hasRiders,
}: {
  free: boolean;
  trip: RideWithZones | null;
  freeSeats: number;
  hasRiders: boolean;
}) {
  const [title, subtitle] = free
    ? ["Finding trips near you", "New requests open full screen with a sound."]
    : trip?.type === "LONE"
      ? [
          "You're on a Ride alone trip",
          "A private trip takes one rider, so new requests show here once it ends.",
        ]
      : freeSeats === 0
        ? ["Your car is full", "Riders on your route show here again when a seat frees up."]
        : hasRiders
          ? [
              "Riders on your route",
              `${freeSeats} free seat${freeSeats === 1 ? "" : "s"} · add one without a detour.`,
            ]
          : [
              "No riders on your route right now",
              "Riders whose trip fits yours show up here as they request.",
            ];
  return (
    <>
      <Text variant="title2" accessibilityRole="header">
        {title}
      </Text>
      <Text variant="subhead" color="secondary">
        {subtitle}
      </Text>
    </>
  );
}

/** The 44px round account button: the driver's photo, or their initial. */
function AccountButton({
  name,
  photoUrl,
  onPress,
}: {
  name: string | null | undefined;
  photoUrl: string | null;
  onPress: () => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Your account"
      style={({ pressed }) => [styles.account, pressed && styles.accountPressed]}
    >
      {photoUrl && !failed ? (
        <Image
          source={{ uri: cloudinaryAvatar(photoUrl, 44) }}
          style={styles.accountPhoto}
          contentFit="cover"
          cachePolicy="memory-disk"
          onError={() => setFailed(true)}
        />
      ) : (
        <Text variant="title3" color="brand">
          {name?.trim().charAt(0).toUpperCase() || "?"}
        </Text>
      )}
    </Pressable>
  );
}

/** "Today GH₵17.50 · 2 trips": white while offline, dark while online. Opens Earnings. */
function TodayPill({
  pesewas,
  trips,
  dark,
  onPress,
}: {
  pesewas: number;
  trips: number;
  dark: boolean;
  onPress: () => void;
}) {
  const tripsLabel = `${trips} trip${trips === 1 ? "" : "s"}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Today ${formatCedis(pesewas)}${trips > 0 ? `, ${tripsLabel}` : ""}. Open earnings`}
      style={[styles.today, dark && styles.todayDark]}
    >
      <Text variant="subhead" color={dark ? "onDark2" : "secondary"}>
        Today
      </Text>
      <Text variant="title3" color={dark ? "onDark" : "default"} tabular>
        {formatCedis(pesewas)}
      </Text>
      {trips > 0 ? (
        <Text variant="subhead" color={dark ? "onDark2" : "secondary"}>
          · {tripsLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** On a trip: the dark first row of the sheet ("Filling your car · 1 rider"), which opens it. */
function TripRow({ trip, onPress }: { trip: RideWithZones; onPress: () => void }) {
  const status = tripStatusLine(trip);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${status}. Open your trip.`}
      style={({ pressed }) => [styles.trip, pressed && styles.tripPressed]}
    >
      <Ionicons name="car-sport" size={22} color={colors.onDark} />
      <View style={styles.tripText}>
        <Text variant="bodyStrong" color="onDark" numberOfLines={2}>
          {status}
        </Text>
        <Text variant="subhead" color="onDark2">
          Tap to open your trip
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.onDark} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mapLand },
  // ── Over the map
  topBar: {
    position: "absolute",
    left: spacing.gutter,
    right: spacing.gutter,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topBarEnd: { width: 44 },
  account: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    ...shadows.float,
  },
  accountPressed: { backgroundColor: colors.surface2 },
  accountPhoto: { width: 44, height: 44 },
  today: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing[2],
    height: 44,
    paddingHorizontal: spacing[5],
    paddingTop: 10,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    ...shadows.float,
  },
  todayDark: { backgroundColor: colors.surfaceDark },
  goOnline: { position: "absolute", left: spacing.gutter, right: spacing.gutter },
  // ── Sheet
  sheet: { gap: spacing[4], paddingBottom: spacing[5] },
  heading: { gap: spacing[2] },
  offlineTitle: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  offlineDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.ink4 },
  onlineChip: { alignSelf: "flex-start" },
  controls: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  filters: { flex: 1 },
  filtersContent: { gap: spacing[2], paddingVertical: 6 },
  problem: { gap: spacing[2] },
  trip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 64,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceDark,
  },
  tripPressed: { backgroundColor: colors.surfaceDark2 },
  tripText: { flex: 1, gap: 2 },
});
