import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { DRIVER_EVENTS } from "@rida/shared";
import {
  Badge,
  Button,
  Card,
  Illustration,
  LoadingState,
  PressableScale,
  Screen,
  Text,
  colors,
  formatCedis,
  getRideSocket,
  radii,
  getDriverActiveRide,
  getFillSuggestions,
  addPassenger,
  passengerArrived,
  passengerPickup,
  passengerDropoff,
  passengerCancel,
  RouteStops,
  shadows,
  spacing,
  typography,
  useAuth,
  useToast,
} from "@rida/mobile-shared";
import type {
  FillSuggestion,
  FillSuggestionsResult,
  PassengerInCar,
  RideWithZones,
} from "@rida/mobile-shared";
import { driverActiveRideQueryKey, markTripOpened, wasTripOpened } from "../../lib/activeTrip";
import { useDriverPresence } from "../../lib/presence";
import { useRequestsNearYou } from "../../lib/requests";

/** Sentinel for the "no specific location" pickup/dropoff filter option. */
const ALL_FILTER = "ALL";

/** Distinct, alphabetically-sorted list of values (stable chip order across polls). */
function distinctSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function timeAgo(isoDate: string): string {
  const diffSecs = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  return `${Math.floor(diffSecs / 60)}m ago`;
}

/**
 * True whenever a SHARED ride is this driver's active car — assembling
 * (MATCHED/ARRIVED) or already driving (IN_PROGRESS). Unlike LONE, a SHARED
 * ride never redirects to /ride/:id: the whole lifecycle, including driving
 * and per-passenger pickup/dropoff, lives on this screen.
 */
function isFillingCar(ride: RideWithZones | null | undefined): boolean {
  return (
    ride !== null &&
    ride !== undefined &&
    ride.type === "SHARED" &&
    (ride.status === "MATCHED" || ride.status === "ARRIVED" || ride.status === "IN_PROGRESS")
  );
}

// ─── Fill-your-car sub-components ────────────────────────────────────────────

function OccupancyStepper({ current, max }: { current: number; max: number }) {
  return (
    <View style={fillStyles.stepper}>
      {Array.from({ length: max }).map((_, i) => (
        <View
          key={i}
          style={[fillStyles.stepDot, i < current ? fillStyles.stepDotFilled : fillStyles.stepDotEmpty]}
        />
      ))}
      <Text variant="bodySmall" color="muted" style={fillStyles.stepperLabel}>
        {current} / {max}
      </Text>
    </View>
  );
}

interface PassengerRowProps {
  /** Status reflects the optimistic overlay, so the button advances instantly
   * on tap; no per-row spinner. */
  passenger: PassengerInCar;
  onArrived: () => void;
  onPickup: () => void;
  onDropoff: () => void;
  /** Cancel is offered for WAITING only — gone once "I'm here" is tapped. */
  onCancel: () => void;
}

/**
 * Status pill spec per passenger state — color + label + dot SHAPE, never a
 * glow/shadow alone (Android elevation ignores shadowColor). Dot shape
 * (round vs. square) carries meaning independent of color, so the state is
 * legible without reading the label text. No blue exists in tokens.ts, so
 * ARRIVED uses the neutral ink family rather than introducing a new hex.
 */
const PASSENGER_STATUS_PILL: Record<
  PassengerInCar["status"],
  { label: string; bg: string; fg: string; dotBg: string; dotBorder: string; square: boolean }
> = {
  WAITING: {
    label: "Waiting",
    bg: colors.warningSurface,
    fg: colors.warning,
    dotBg: "transparent",
    dotBorder: colors.warning,
    square: false,
  },
  ARRIVED: {
    label: "Arrived",
    bg: colors.ink[50],
    fg: colors.ink[600],
    dotBg: colors.ink[400],
    dotBorder: colors.ink[400],
    square: false,
  },
  PICKED_UP: {
    label: "Picked up",
    bg: colors.successSurface,
    fg: colors.success,
    dotBg: colors.success,
    dotBorder: colors.success,
    square: true,
  },
  DROPPED_OFF: {
    label: "Dropped off",
    bg: colors.surfaceMuted,
    fg: colors.ink[500],
    dotBg: colors.ink[300],
    dotBorder: colors.ink[300],
    square: false,
  },
  CANCELLED: {
    label: "Cancelled",
    bg: colors.errorSurface,
    fg: colors.danger,
    dotBg: colors.danger,
    dotBorder: colors.danger,
    square: false,
  },
};

function PassengerStatusPill({ status }: { status: PassengerInCar["status"] }) {
  const pill = PASSENGER_STATUS_PILL[status];
  return (
    <View style={[fillStyles.statusPill, { backgroundColor: pill.bg }]}>
      <View
        style={[
          fillStyles.statusDot,
          pill.square ? fillStyles.statusDotSquare : fillStyles.statusDotRound,
          { backgroundColor: pill.dotBg, borderColor: pill.dotBorder },
        ]}
      />
      <Text variant="caption" style={{ color: pill.fg, fontWeight: typography.weight.semibold }}>
        {pill.label}
      </Text>
    </View>
  );
}

function PassengerRow({ passenger, onArrived, onPickup, onDropoff, onCancel }: PassengerRowProps) {
  return (
    <View style={fillStyles.passengerRow}>
      <View style={fillStyles.passengerMarkerCol}>
        <View style={fillStyles.passengerPickupDot} />
        <View style={fillStyles.passengerConnector} />
        <Ionicons name="location" size={12} color={colors.ink[600]} />
      </View>
      <View style={fillStyles.passengerTextCol}>
        <View style={fillStyles.passengerPillRow}>
          <PassengerStatusPill status={passenger.status} />
        </View>
        <Text variant="bodySmall">{passenger.pickupZoneName}</Text>
        <Text variant="bodySmall">{passenger.dropoffZoneName}</Text>
        {passenger.lockedFare !== null && (
          <Text variant="caption" color="muted">{formatCedis(passenger.lockedFare)}</Text>
        )}
      </View>
      <View style={fillStyles.passengerActionCol}>
        {passenger.status === "WAITING" && (
          <View style={fillStyles.waitingActions}>
            <Button label="I'm here" variant="secondary" onPress={onArrived} />
            <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
              <Text variant="caption" style={fillStyles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        )}
        {passenger.status === "ARRIVED" && (
          <Button label="Start pickup" onPress={onPickup} />
        )}
        {passenger.status === "PICKED_UP" && (
          <Button label="Drop off" onPress={onDropoff} />
        )}
        {passenger.status === "DROPPED_OFF" && (
          <Ionicons name="checkmark-circle" size={24} color={colors.primary[500]} />
        )}
      </View>
    </View>
  );
}

interface SuggestionCardProps {
  suggestion: FillSuggestion;
  adding: boolean;
  onAdd: () => void;
}

function SuggestionCard({ suggestion, adding, onAdd }: SuggestionCardProps) {
  return (
    <Card style={fillStyles.suggestionCard}>
      {suggestion.compatible && (
        <Badge variant="accent" label="★  Best match" style={fillStyles.suggBadge} />
      )}
      {/* Route — geometry only, no "Pickup"/"Dropoff" text labels (the
          marker shapes already carry that meaning; see RouteStops). */}
      <RouteStops
        connectorHeight={20}
        origin={<Text variant="bodyMedium">{suggestion.pickupZoneName}</Text>}
        destination={<Text variant="bodyMedium">{suggestion.dropoffZoneName}</Text>}
      />

      <Text variant="caption" color="muted">{timeAgo(suggestion.createdAt)}</Text>

      <Button label={adding ? "Adding…" : "Add to car"} loading={adding} onPress={onAdd} fullWidth />
    </Card>
  );
}

interface FillYourCarProps {
  ride: RideWithZones;
  fillData: FillSuggestionsResult | undefined;
  addingRideId: string | null;
  /** Optimistic per-passenger status overlay (passengerId -> advanced status). */
  optimistic: Record<string, PassengerInCar["status"]>;
  onAddPassenger: (requestRideId: string) => void;
  onPassengerArrived: (passengerId: string) => void;
  onPassengerPickup: (passengerId: string) => void;
  onPassengerDropoff: (passengerId: string) => void;
  onPassengerCancel: (passengerId: string) => void;
}

function FillYourCarView({
  ride,
  fillData,
  addingRideId,
  optimistic,
  onAddPassenger,
  onPassengerArrived,
  onPassengerPickup,
  onPassengerDropoff,
  onPassengerCancel,
}: FillYourCarProps) {
  // Pickup -> dropoff filter for the addable pending-requests list (same model
  // as the home browsing filter). Filters which requests can be added; it
  // never touches the passengers already in the car.
  const [suggPickup, setSuggPickup] = useState<string>(ALL_FILTER);
  const [suggDropoff, setSuggDropoff] = useState<string>(ALL_FILTER);

  // Assembling = car still open to new adds (MATCHED/ARRIVED). Driving =
  // IN_PROGRESS, car closed — the first passenger pickup already walked the
  // ride here automatically, so there is no ride-level "Depart" button.
  const isAssembling = ride.status === "MATCHED" || ride.status === "ARRIVED";

  // While assembling, fillData (polled) is the live source for passengers +
  // suggestions. Once driving, fillData stops being fetched (car is closed,
  // the backend would 400) — fall back to the ride's own passenger list.
  const passengers: PassengerInCar[] = isAssembling
    ? fillData?.passengers ?? ride.passengers
    : ride.passengers;
  const occupancy = isAssembling ? fillData?.occupancy ?? ride.occupancy : ride.occupancy;
  const suggestions: FillSuggestion[] = isAssembling ? fillData?.suggestions ?? [] : [];
  const isFull = occupancy >= 4;

  // Dependent pickup -> dropoff filter over the suggestions, with the same
  // effective-value guard as the home list (a value not in the live options
  // falls back to ALL, so the list never freezes on a stale selection).
  const suggPickupOptions = distinctSorted(suggestions.map((s) => s.pickupZoneName));
  const effSuggPickup = suggPickupOptions.includes(suggPickup) ? suggPickup : ALL_FILTER;
  const suggDropoffPool =
    effSuggPickup === ALL_FILTER
      ? suggestions
      : suggestions.filter((s) => s.pickupZoneName === effSuggPickup);
  const suggDropoffOptions = distinctSorted(suggDropoffPool.map((s) => s.dropoffZoneName));
  const effSuggDropoff = suggDropoffOptions.includes(suggDropoff) ? suggDropoff : ALL_FILTER;
  const visibleSuggestions = suggDropoffPool.filter(
    (s) => effSuggDropoff === ALL_FILTER || s.dropoffZoneName === effSuggDropoff,
  );
  const selectSuggPickup = (value: string) => {
    setSuggPickup(value);
    setSuggDropoff(ALL_FILTER);
  };

  // Apply the optimistic overlay so a tapped row advances instantly, then drop
  // completed/cancelled passengers (the car stays active with whoever remains).
  // Server keeps rows in createdAt order (stable), so we never re-sort here —
  // order is locked, first-added on top.
  const visiblePassengers = passengers
    .map((p) => ({ ...p, status: optimistic[p.id] ?? p.status }))
    .filter((p) => p.status === "WAITING" || p.status === "ARRIVED" || p.status === "PICKED_UP");

  return (
    <>
      {/* Status banner */}
      <View style={fillStyles.statusBanner}>
        <View style={[fillStyles.bannerDot, isAssembling ? fillStyles.bannerDotMatched : fillStyles.bannerDotArrived]} />
        <Text variant="bodySmall" style={fillStyles.bannerText}>
          {isAssembling ? "Assembling · On the way to pickups" : "On the road · Picking up & dropping off"}
        </Text>
      </View>

      {!isAssembling && occupancy > 1 && (
        <View style={fillStyles.sharedNotice}>
          <Ionicons name="people" size={16} color={colors.warning} />
          <Text variant="bodySmall" style={fillStyles.sharedNoticeText}>
            Shared trip · {occupancy} riders, separate dropoffs
          </Text>
        </View>
      )}

      {/* Current car card */}
      <Card style={fillStyles.carCard}>
        <View style={fillStyles.carHeader}>
          <View style={fillStyles.carRouteCompact}>
            <Text variant="bodyMedium" style={fillStyles.carZoneName}>{ride.pickupZone.name}</Text>
            <Ionicons name="arrow-forward" size={14} color={colors.ink[400]} />
            <Text variant="bodyMedium" style={fillStyles.carZoneName}>{ride.dropoffZone.name}</Text>
          </View>
          <OccupancyStepper current={occupancy} max={4} />
        </View>

        {visiblePassengers.length > 0 ? (
          <View style={fillStyles.passengerList}>
            {visiblePassengers.map((p) => (
              <PassengerRow
                key={p.id}
                passenger={p}
                onArrived={() => onPassengerArrived(p.id)}
                onPickup={() => onPassengerPickup(p.id)}
                onDropoff={() => onPassengerDropoff(p.id)}
                onCancel={() => onPassengerCancel(p.id)}
              />
            ))}
          </View>
        ) : (
          <Text variant="caption" color="muted" style={fillStyles.noPassengersNote}>
            Passenger details loading…
          </Text>
        )}
      </Card>

      {/* Suggestions section — assembling only; the car closes to new adds once driving. */}
      {isAssembling && (
        <View style={fillStyles.suggestionsSection}>
          <View style={fillStyles.sectionHeader}>
            <Text variant="label" color="muted">NEARBY REQUESTS</Text>
            {!isFull && (
              <View style={fillStyles.sectionCount}>
                <Text variant="caption" color="muted">{visibleSuggestions.length}</Text>
              </View>
            )}
          </View>

          {/* Filter the addable requests only — never the in-car passengers. */}
          {!isFull && suggestions.length > 0 && (
            <View style={fillStyles.suggFilters}>
              <FilterChipRow
                label="Pickup"
                options={suggPickupOptions}
                selected={effSuggPickup}
                onSelect={selectSuggPickup}
              />
              <FilterChipRow
                label="Dropoff"
                options={suggDropoffOptions}
                selected={effSuggDropoff}
                onSelect={setSuggDropoff}
              />
            </View>
          )}

          {isFull ? (
            <View style={fillStyles.fullBanner}>
              <Illustration name="carFull" size={48} />
              <Text variant="bodyMedium" style={fillStyles.fullText}>Car is full — 4 / 4</Text>
            </View>
          ) : suggestions.length === 0 ? (
            <View style={fillStyles.emptySuggestions}>
              <Illustration name="searchEmpty" size={88} />
              <Text variant="bodySmall" color="muted">No compatible requests nearby right now.</Text>
            </View>
          ) : visibleSuggestions.length === 0 ? (
            <View style={fillStyles.emptySuggestions}>
              <Illustration name="searchEmpty" size={88} />
              <Text variant="bodySmall" color="muted">No requests match this pickup and dropoff.</Text>
            </View>
          ) : (
            visibleSuggestions.map((s) => (
              <SuggestionCard
                key={s.requestRideId}
                suggestion={s}
                adding={addingRideId === s.requestRideId}
                onAdd={() => onAddPassenger(s.requestRideId)}
              />
            ))
          )}
        </View>
      )}
    </>
  );
}

// ─── Shared filter chips (fill-your-car suggestions) ─────────────────────────

interface FilterChipRowProps {
  label: string;
  /** Distinct location names (without the "All" sentinel — prepended here). */
  options: string[];
  /** Currently effective selection (ALL_FILTER or one of `options`). */
  selected: string;
  onSelect: (value: string) => void;
}

/** One horizontally-scrollable line of filter chips: "All" + each distinct location. */
function FilterChipRow({ label, options, selected, onSelect }: FilterChipRowProps) {
  return (
    <View style={styles.filterRow}>
      <Text variant="label" color="muted" style={styles.filterLabel}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterChips}
      >
        {[ALL_FILTER, ...options].map((value) => {
          const active = value === selected;
          return (
            <Pressable
              key={value}
              onPress={() => onSelect(value)}
              style={[styles.filterChip, active && styles.filterChipActive]}
            >
              <Text
                variant="bodySmall"
                style={active ? styles.filterChipTextActive : styles.filterChipText}
              >
                {value === ALL_FILTER ? "All" : value}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function DriverHomeScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isLoading: authLoading, isAuthenticated, user, signOut } = useAuth();

  const [addingRideId, setAddingRideId] = useState<string | null>(null);
  // Optimistic per-passenger status overlay (passengerId -> advanced status),
  // applied over server data; cleared once the server catches up, or rolled
  // back on failure. inFlightRef serializes actions per passenger.
  const [optimistic, setOptimistic] = useState<Record<string, PassengerInCar["status"]>>({});
  const inFlightRef = useRef<Set<string>>(new Set());
  const { showToast, toast } = useToast();

  const { isOnline, waking, toggle } = useDriverPresence();

  const { data: activeRide, isLoading: rideLoading } = useQuery({
    queryKey: driverActiveRideQueryKey,
    queryFn: getDriverActiveRide,
    enabled: isAuthenticated,
    refetchInterval: 15_000,
  });

  const filling = isFillingCar(activeRide);
  // The car is still open to new adds (and fill-suggestions is a valid call)
  // only while MATCHED/ARRIVED — once IN_PROGRESS the backend would 400.
  const assembling = filling && activeRide?.status !== "IN_PROGRESS";

  // Fill-suggestions — polled every 10 s while assembling a shared car.
  const { data: fillData, refetch: refetchFill } = useQuery({
    queryKey: ["fillSuggestions", activeRide?.id],
    queryFn: () => getFillSuggestions(activeRide!.id),
    enabled: isAuthenticated && assembling,
    refetchInterval: 10_000,
  });

  // "Requests near you (N)" — not while on ANY trip: a driver with an active
  // ride can't claim another (the server refuses).
  const { data: requests = [] } = useRequestsNearYou(isOnline && !activeRide);

  // Open the driving screen for a LONE trip — once per trip. SHARED rides —
  // every status including IN_PROGRESS — stay on this screen for the whole
  // lifecycle: assembling, then per-passenger pickup/dropoff while driving.
  //
  // PUSH, not replace: replacing threw the tab screens away, so mid-trip the
  // driver couldn't reach Rides/Account and "back" had nowhere to go. And
  // only once per trip, so a driver who steps back to Home isn't bounced
  // straight back; the active-trip banner is how they return.
  useEffect(() => {
    if (!activeRide || activeRide.type !== "LONE" || wasTripOpened(activeRide.id)) return;
    markTripOpened(activeRide.id);
    router.push(`/ride/${activeRide.id}`);
  }, [activeRide, router]);

  // Socket: a new broadcast may be addable to the car being filled. (The
  // requests list refreshes itself; see useRequestsNearYou.) While driving,
  // the car is closed to new adds, so there's nothing to refetch.
  useEffect(() => {
    if (!isAuthenticated || !assembling) return;
    const socket = getRideSocket();
    const onBroadcast = () => void refetchFill();
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [isAuthenticated, assembling, refetchFill]);

  // Fill-your-car: add a compatible passenger.
  const handleAddPassenger = useCallback(
    async (requestRideId: string) => {
      if (!activeRide || addingRideId !== null) return;
      setAddingRideId(requestRideId);
      try {
        await addPassenger(activeRide.id, requestRideId);
        void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
        void refetchFill();
      } catch (err) {
        const httpStatus = (err as { response?: { status?: number } }).response?.status;
        const msg =
          httpStatus === 409
            ? "This request was just taken by another driver or is no longer available."
            : "Could not add passenger. Try again.";
        Alert.alert("Could not add", msg);
        void refetchFill();
      } finally {
        setAddingRideId(null);
      }
    },
    [activeRide, addingRideId, queryClient, refetchFill],
  );

  // Optimistic per-passenger transition: advance the row instantly, fire the
  // request in the background, and on failure silently roll back + toast. One
  // in-flight action per passenger so a rapid second tap can't outrun the
  // server's ordering. The overlay is cleared only after the refreshed server
  // data has caught up (await the refetch), so there is no backward flicker.
  const runTransition = useCallback(
    async (
      passengerId: string,
      target: PassengerInCar["status"],
      call: (rideId: string) => Promise<unknown>,
      failMessage: string,
    ) => {
      if (!activeRide || inFlightRef.current.has(passengerId)) return;
      const rideId = activeRide.id;
      inFlightRef.current.add(passengerId);
      setOptimistic((prev) => ({ ...prev, [passengerId]: target }));
      const clear = () =>
        setOptimistic((prev) => {
          const next = { ...prev };
          delete next[passengerId];
          return next;
        });
      try {
        await call(rideId);
        await queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
        // Assembling shows the polled fill list; refresh it too before clearing.
        if (assembling) await refetchFill();
        clear();
      } catch {
        clear();
        showToast(failMessage);
      } finally {
        inFlightRef.current.delete(passengerId);
      }
    },
    [activeRide, assembling, queryClient, refetchFill, showToast],
  );

  const handlePassengerArrived = useCallback(
    (passengerId: string) =>
      void runTransition(
        passengerId,
        "ARRIVED",
        (rideId) => passengerArrived(rideId, passengerId),
        "Couldn't mark arrived — reverted",
      ),
    [runTransition],
  );

  const handlePassengerPickup = useCallback(
    (passengerId: string) =>
      void runTransition(
        passengerId,
        "PICKED_UP",
        (rideId) => passengerPickup(rideId, passengerId),
        "Couldn't start pickup — reverted",
      ),
    [runTransition],
  );

  const handlePassengerDropoff = useCallback(
    (passengerId: string) =>
      void runTransition(
        passengerId,
        "DROPPED_OFF",
        (rideId) => passengerDropoff(rideId, passengerId),
        "Couldn't drop off — reverted",
      ),
    [runTransition],
  );

  // Cancel before pickup (WAITING only). Confirm first — it drops the rider
  // from the car and notifies them — then run it through the same optimistic
  // path (row disappears instantly; reverts + toast on failure).
  const handlePassengerCancel = useCallback(
    (passengerId: string) => {
      Alert.alert("Remove rider?", "They'll be told their pickup was cancelled.", [
        { text: "Keep", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            void runTransition(
              passengerId,
              "CANCELLED",
              (rideId) => passengerCancel(rideId, passengerId),
              "Couldn't cancel — reverted",
            ),
        },
      ]);
    },
    [runTransition],
  );

  // ─── Loading guard ────────────────────────────────────────────────────────
  // Auth/role/onboarding are already gated by the parent (tabs) layout — by
  // the time this screen renders, the user is a confirmed onboarded driver.

  if (authLoading || rideLoading || !user) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const firstName = user.name?.split(" ")[0] ?? "Driver";

  // ─── On a LONE trip, stepped back to Home ────────────────────────────────────
  // The trip is driven on its own screen; Home just says so and leads back.
  if (activeRide && activeRide.type === "LONE") {
    return (
      <Screen>
        <View style={styles.onTrip}>
          <Illustration name="carIdle" size={140} float />
          <Text variant="h2" style={styles.onTripText}>
            You&apos;re on a trip
          </Text>
          <Text variant="bodySmall" color="muted" style={styles.onTripText}>
            {activeRide.pickupZone.name} → {activeRide.dropoffZone.name}
          </Text>
          <Button label="Return to trip" size="lg" onPress={() => router.push(`/ride/${activeRide.id}`)} />
        </View>
      </Screen>
    );
  }

  // ─── Fill-your-car mode (SHARED: assembling, then driving) ──────────────────

  if (filling && activeRide) {
    return (
      <View style={styles.screenRoot}>
        <Screen scroll>
        <View style={styles.header}>
          <View>
            <Text variant="bodySmall" color="muted">{assembling ? "Assembling" : "Driving"}</Text>
            <Text variant="h1">Your car</Text>
          </View>
          <Pressable
            onPress={() =>
              Alert.alert("Sign out?", "Signing out won't end this trip — your riders are still expecting you.", [
                { text: "Cancel", style: "cancel" },
                { text: "Sign out", style: "destructive", onPress: () => void signOut() },
              ])
            }
            style={styles.avatar}
            accessibilityRole="button"
            accessibilityLabel="Account"
          >
            <Text variant="h3" color="inverse">{firstName.charAt(0).toUpperCase()}</Text>
          </Pressable>
        </View>

        <FillYourCarView
          ride={activeRide}
          fillData={fillData}
          addingRideId={addingRideId}
          optimistic={optimistic}
          onAddPassenger={(rideId) => void handleAddPassenger(rideId)}
          onPassengerArrived={(passengerId) => void handlePassengerArrived(passengerId)}
          onPassengerPickup={(passengerId) => void handlePassengerPickup(passengerId)}
          onPassengerDropoff={(passengerId) => void handlePassengerDropoff(passengerId)}
          onPassengerCancel={(passengerId) => handlePassengerCancel(passengerId)}
        />
        </Screen>
        {toast}
      </View>
    );
  }

  // ─── Normal home: waiting for requests ───────────────────────────────────────

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <Text variant="bodySmall" color="muted">Welcome back</Text>
          <Text variant="h1">{firstName}</Text>
        </View>
        <View style={styles.onlineToggle}>
          <View style={[styles.statusDot, isOnline ? styles.dotOnline : styles.dotOffline]} />
          <Text variant="bodySmall" style={styles.onlineLabel}>
            {isOnline ? "Online" : "Offline"}
          </Text>
          {/* Flips on tap; the server is told in the background (lib/presence). */}
          <Switch
            value={isOnline}
            onValueChange={toggle}
            trackColor={{ false: colors.ink[100], true: colors.primary[200] }}
            thumbColor={isOnline ? colors.primary[500] : colors.ink[300]}
            accessibilityLabel="Online"
            accessibilityHint={isOnline ? "Go offline and stop receiving requests" : "Go online to receive requests"}
          />
        </View>
      </View>

      {waking && (
        <Text variant="caption" color="muted" style={styles.waking} accessibilityLiveRegion="polite">
          Connecting to CampusRide… this can take a few seconds.
        </Text>
      )}

      {!isOnline ? (
        <View style={styles.emptyState}>
          <Illustration name="carIdle" size={180} float accessibilityLabel="Parked car" />
          <Text variant="h3" style={styles.emptyTitle}>Ready when you are</Text>
          <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
            Toggle online above to start accepting trips around campus.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.hero}>
            <Illustration name="pinRadar" size={150} pulse accessibilityLabel="Map pin" />
            <Text variant="h3" style={styles.emptyTitle}>Waiting for requests</Text>
            <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
              Keep the app open. Requests near you show up below.
            </Text>
          </View>

          <PressableScale
            onPress={() => router.push("/requests")}
            style={styles.nearYouCard}
            accessibilityRole="button"
            accessibilityLabel={`Requests near you, ${requests.length} ${requests.length === 1 ? "request" : "requests"}`}
            accessibilityHint="Browse and pick one yourself"
          >
            <View style={styles.nearYouCount}>
              <Text variant="bodyMedium" style={styles.nearYouCountText}>{requests.length}</Text>
            </View>
            <View style={styles.nearYouText}>
              <Text variant="bodyMedium" style={styles.nearYouTitle}>Requests near you</Text>
              <Text variant="caption" color="muted">Browse and pick one yourself</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.ink[300]} />
          </PressableScale>
        </>
      )}
    </Screen>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  onTrip: { flex: 1, justifyContent: "center", alignItems: "stretch", gap: spacing.md },
  onTripText: { textAlign: "center" },
  // Wraps the fill-your-car Screen so the toast can pin to the viewport bottom.
  screenRoot: { flex: 1 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xl,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
    alignItems: "center",
    justifyContent: "center",
  },
  onlineToggle: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  onlineLabel: { fontWeight: typography.weight.semibold },
  statusDot: { width: 10, height: 10, borderRadius: radii.full },
  dotOnline: { backgroundColor: colors.primary[500] },
  dotOffline: { backgroundColor: colors.ink[300] },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingTop: spacing["4xl"],
    paddingBottom: spacing["4xl"],
  },
  emptyTitle: { marginTop: spacing.sm },
  emptyBody: { textAlign: "center", maxWidth: 260 },
  // Pickup/dropoff filter over the car's addable requests — two scrollable chip lines.
  filterRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  filterLabel: { width: 52 },
  filterChips: { gap: spacing.xs, paddingRight: spacing.md },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    backgroundColor: colors.surfaceMuted,
  },
  filterChipActive: { backgroundColor: colors.primary[500] },
  filterChipText: { color: colors.ink[500] },
  filterChipTextActive: { color: colors.white, fontWeight: typography.weight.semibold },
  waking: { marginTop: -spacing.md, marginBottom: spacing.md, textAlign: "right" },
  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingBottom: spacing["3xl"],
  },
  nearYouCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.lg,
    ...shadows.sm,
  },
  nearYouCount: {
    width: 32,
    height: 32,
    borderRadius: radii.full,
    backgroundColor: colors.primary[50],
    alignItems: "center",
    justifyContent: "center",
  },
  nearYouCountText: { color: colors.primary[500], fontWeight: typography.weight.extrabold },
  nearYouText: { flex: 1, gap: 1 },
  nearYouTitle: { fontWeight: typography.weight.bold },
});

// Fill-your-car styles (separate namespace to stay organised)
const fillStyles = StyleSheet.create({
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.lg,
  },
  bannerDot: { width: 8, height: 8, borderRadius: radii.full },
  bannerDotMatched: { backgroundColor: colors.accent[500] },
  bannerDotArrived: { backgroundColor: colors.primary[500] },
  bannerText: { flex: 1 },
  sharedNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.warningSurface,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  sharedNoticeText: { flex: 1, color: colors.warning, fontWeight: typography.weight.semibold },
  // Car card
  carCard: { gap: spacing.md, marginBottom: spacing.lg },
  carHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  carRouteCompact: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flex: 1, flexWrap: "wrap" },
  carZoneName: { fontWeight: "600" as const },
  stepper: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  stepDot: { width: 10, height: 10, borderRadius: radii.full },
  stepDotFilled: { backgroundColor: colors.primary[500] },
  stepDotEmpty: { backgroundColor: colors.ink[100] },
  stepperLabel: { marginLeft: spacing.xs },
  passengerList: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  passengerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  passengerMarkerCol: { width: 16, alignItems: "center", gap: 1, paddingTop: 2 },
  passengerPickupDot: {
    width: 8, height: 8, borderRadius: radii.full, backgroundColor: colors.primary[400],
  },
  passengerConnector: { width: 1, height: 16, backgroundColor: colors.border },
  passengerTextCol: { flex: 1, gap: 2 },
  passengerPillRow: { marginBottom: 2 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  statusDot: { width: 7, height: 7, borderWidth: 1.5 },
  statusDotRound: { borderRadius: radii.full },
  statusDotSquare: { borderRadius: radii.sm },
  passengerActionCol: { alignItems: "flex-end", justifyContent: "center" },
  waitingActions: { alignItems: "flex-end", gap: spacing.xs },
  cancelText: { color: colors.danger, fontWeight: typography.weight.semibold },
  noPassengersNote: { textAlign: "center", paddingVertical: spacing.sm },
  // Suggestions
  suggestionsSection: { marginTop: spacing.sm },
  suggFilters: { gap: spacing.sm, marginBottom: spacing.md },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md,
  },
  sectionCount: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.full,
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  fullBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.successSurface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  fullText: { color: colors.success },
  emptySuggestions: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  // Suggestion card
  suggestionCard: { gap: spacing.sm, marginBottom: spacing.md },
  suggBadge: { alignSelf: "flex-start" },
});
