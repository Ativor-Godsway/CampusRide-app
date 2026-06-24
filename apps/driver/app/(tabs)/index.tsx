import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { nearestZone } from "@rida/shared";
import { DRIVER_EVENTS } from "@rida/shared";
import {
  Badge,
  Button,
  Card,
  LoadingState,
  Screen,
  Text,
  colors,
  formatGhs,
  getZones,
  getRideSocket,
  radii,
  setDriverAvailability,
  driverClaimRide,
  getDriverActiveRide,
  getEligibleRides,
  getFillSuggestions,
  addPassenger,
  passengerArrived,
  passengerPickup,
  passengerDropoff,
  RouteStops,
  shadows,
  spacing,
  typography,
  useAuth,
} from "@rida/mobile-shared";
import type {
  EligibleRideItem,
  FillSuggestion,
  FillSuggestionsResult,
  PassengerInCar,
  RideWithZones,
} from "@rida/mobile-shared";

type DriverStatus = "offline" | "online" | "on_ride";
type SortBy = "pickup" | "dropoff";

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
  passenger: PassengerInCar;
  /** Independent per-row loading state, keyed by passengerId by the caller —
   * never a single shared boolean, so multiple rows stay tappable at once. */
  acting: boolean;
  onArrived: () => void;
  onPickup: () => void;
  onDropoff: () => void;
}

function PassengerRow({ passenger, acting, onArrived, onPickup, onDropoff }: PassengerRowProps) {
  return (
    <View style={fillStyles.passengerRow}>
      <View style={fillStyles.passengerMarkerCol}>
        <View style={fillStyles.passengerPickupDot} />
        <View style={fillStyles.passengerConnector} />
        <Ionicons name="location" size={12} color={colors.ink[600]} />
      </View>
      <View style={fillStyles.passengerTextCol}>
        <Text variant="bodySmall">{passenger.pickupZoneName}</Text>
        <Text variant="bodySmall">{passenger.dropoffZoneName}</Text>
        {passenger.lockedFare !== null && (
          <Text variant="caption" color="muted">{formatGhs(passenger.lockedFare)}</Text>
        )}
      </View>
      <View style={fillStyles.passengerActionCol}>
        {passenger.status === "WAITING" && (
          <Button
            label={acting ? "…" : "I'm here"}
            variant="secondary"
            loading={acting}
            onPress={onArrived}
          />
        )}
        {passenger.status === "ARRIVED" && (
          <Button label={acting ? "…" : "Start pickup"} loading={acting} onPress={onPickup} />
        )}
        {passenger.status === "PICKED_UP" && (
          <Button label={acting ? "…" : "Drop off"} loading={acting} onPress={onDropoff} />
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
      {/* Route */}
      <RouteStops
        connectorHeight={20}
        origin={
          <>
            <Text variant="bodySmall" color="muted">Pickup</Text>
            <Text variant="bodyMedium">{suggestion.pickupZoneName}</Text>
          </>
        }
        destination={
          <>
            <Text variant="bodySmall" color="muted">Dropoff</Text>
            <Text variant="bodyMedium">{suggestion.dropoffZoneName}</Text>
          </>
        }
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
  /** The one passenger row currently mid-action, if any — independent of
   * addingRideId so suggestion-adding and passenger actions never block each other. */
  actingPassengerId: string | null;
  onAddPassenger: (requestRideId: string) => void;
  onPassengerArrived: (passengerId: string) => void;
  onPassengerPickup: (passengerId: string) => void;
  onPassengerDropoff: (passengerId: string) => void;
}

function FillYourCarView({
  ride,
  fillData,
  addingRideId,
  actingPassengerId,
  onAddPassenger,
  onPassengerArrived,
  onPassengerPickup,
  onPassengerDropoff,
}: FillYourCarProps) {
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

        {passengers.length > 0 ? (
          <View style={fillStyles.passengerList}>
            {passengers.map((p) => (
              <PassengerRow
                key={p.id}
                passenger={p}
                acting={actingPassengerId === p.id}
                onArrived={() => onPassengerArrived(p.id)}
                onPickup={() => onPassengerPickup(p.id)}
                onDropoff={() => onPassengerDropoff(p.id)}
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
                <Text variant="caption" color="muted">{suggestions.length}</Text>
              </View>
            )}
          </View>

          {isFull ? (
            <View style={fillStyles.fullBanner}>
              <Ionicons name="car" size={22} color={colors.primary[500]} />
              <Text variant="bodyMedium" style={fillStyles.fullText}>Car is full — 4 / 4</Text>
            </View>
          ) : suggestions.length === 0 ? (
            <View style={fillStyles.emptySuggestions}>
              <Text variant="bodySmall" color="muted">No compatible requests nearby right now.</Text>
            </View>
          ) : (
            suggestions.map((s) => (
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

// ─── 6b-1 request-list sub-components (unchanged) ────────────────────────────

interface RequestCardProps {
  ride: EligibleRideItem;
  claiming: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

function RequestCard({ ride, claiming, onAccept, onDecline }: RequestCardProps) {
  return (
    <Card style={styles.requestCard}>
      {ride.bestFit && (
        <Badge variant="accent" label="★  Best match" style={styles.bestMatchBadge} />
      )}
      <RouteStops
        style={styles.routeRow}
        origin={
          <View style={styles.zoneBlock}>
            <Text variant="label" color="muted">PICKUP</Text>
            <Text variant="bodyMedium">{ride.pickupZoneName}</Text>
          </View>
        }
        destination={
          <View style={styles.zoneBlock}>
            <Text variant="label" color="muted">DROPOFF</Text>
            <Text variant="bodyMedium">{ride.dropoffZoneName}</Text>
          </View>
        }
      />
      <View style={styles.fareStrip}>
        <View style={styles.fareStripItem}>
          <Text variant="label" color="muted">FARE</Text>
          <Text variant="bodyMedium">{formatGhs(ride.farePesewas)}</Text>
        </View>
        <View style={styles.fareStripItem}>
          <Text variant="label" color="muted">YOU EARN</Text>
          <Text variant="bodyMedium" style={styles.earnText}>
            {formatGhs(ride.driverSharePesewas)}
          </Text>
        </View>
        <View style={styles.fareStripItem}>
          <Text variant="label" color="muted">POSTED</Text>
          <Text variant="bodyMedium">{timeAgo(ride.createdAt)}</Text>
        </View>
      </View>
      <View style={styles.cardActions}>
        <View style={styles.declineWrap}>
          <Button label="Decline" variant="secondary" onPress={onDecline} fullWidth />
        </View>
        <View style={styles.acceptWrap}>
          <Button
            label={claiming ? "Claiming…" : "Accept"}
            onPress={onAccept}
            loading={claiming}
            fullWidth
          />
        </View>
      </View>
    </Card>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.sectionHeader}>
      <Text variant="label" color="muted">{title}</Text>
      <View style={styles.sectionCount}>
        <Text variant="caption" color="muted">{count}</Text>
      </View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function DriverHomeScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isLoading: authLoading, isAuthenticated, user, signOut } = useAuth();

  const [status, setStatus] = useState<DriverStatus>("offline");
  const [sortBy, setSortBy] = useState<SortBy>("pickup");
  const [declinedRideIds, setDeclinedRideIds] = useState<Set<string>>(new Set());
  const [claimingRideId, setClaimingRideId] = useState<string | null>(null);
  const [addingRideId, setAddingRideId] = useState<string | null>(null);
  const [actingPassengerId, setActingPassengerId] = useState<string | null>(null);
  const [completedSummary, setCompletedSummary] = useState<{ occupancy: number } | null>(null);

  const isOnline = status === "online" || status === "on_ride";

  const { data: zones } = useQuery({
    queryKey: ["zones"],
    queryFn: getZones,
    enabled: isAuthenticated,
  });

  const { data: activeRide, isLoading: rideLoading } = useQuery({
    queryKey: ["driverActiveRide"],
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

  // Eligible-rides list — polled every 10 s when online (and not filling a car).
  const { data: rawEligibleRides = [], refetch: refetchEligible } = useQuery({
    queryKey: ["eligibleRides"],
    queryFn: getEligibleRides,
    enabled: isAuthenticated && isOnline && !filling,
    refetchInterval: 10_000,
  });

  // Redirect to the driving screen for LONE rides only. SHARED rides — every
  // status including IN_PROGRESS — stay on this screen for the whole
  // lifecycle: assembling, then per-passenger pickup/dropoff while driving.
  useEffect(() => {
    if (!activeRide) return;
    if (activeRide.type === "LONE") {
      router.replace(`/ride/${activeRide.id}`);
    }
  }, [activeRide, router]);

  // Socket: refresh the appropriate list when a new broadcast arrives.
  // While driving (filling but not assembling), the car is closed to new
  // adds — there is nothing broadcast-relevant to refetch.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!filling && !isOnline) return;
    const socket = getRideSocket();
    const onBroadcast = () => {
      if (assembling) {
        void refetchFill();
      } else if (!filling) {
        void refetchEligible();
      }
    };
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [isAuthenticated, filling, assembling, isOnline, refetchFill, refetchEligible]);

  const availabilityMutation = useMutation({
    mutationFn: ({ isOnline: on, zoneId }: { isOnline: boolean; zoneId?: string }) =>
      setDriverAvailability(on, zoneId),
    onSuccess: (_data, vars) => {
      setStatus(vars.isOnline ? "online" : "offline");
      if (!vars.isOnline) setDeclinedRideIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
      void queryClient.invalidateQueries({ queryKey: ["eligibleRides"] });
    },
    onError: () => {
      Alert.alert("Error", "Could not update availability. Make sure your account is approved.");
    },
  });

  const handleToggle = useCallback(async () => {
    if (status === "offline") {
      const { status: permStatus } = await Location.requestForegroundPermissionsAsync();
      if (permStatus !== "granted") {
        Alert.alert("Location required", "Enable location so we can match you with nearby riders.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const zone = nearestZone(pos.coords.latitude, pos.coords.longitude, zones ?? []);
      availabilityMutation.mutate({ isOnline: true, zoneId: zone?.id });
    } else {
      availabilityMutation.mutate({ isOnline: false });
    }
  }, [status, zones, availabilityMutation]);

  // 6b-1: accept a request from the eligible-rides list.
  // SHARED claims stay on this screen (fill-your-car appears when activeRide refreshes).
  // LONE claims navigate to /ride/:id immediately.
  const handleAccept = useCallback(
    async (ride: EligibleRideItem) => {
      if (claimingRideId !== null) return;
      setClaimingRideId(ride.rideId);
      try {
        await driverClaimRide(ride.rideId);
        void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
        if (ride.type === "LONE") {
          router.push(`/ride/${ride.rideId}`);
        }
        // SHARED: stay here — activeRide polling will detect MATCHED and switch to fill view
      } catch (err) {
        const httpStatus = (err as { response?: { status?: number } }).response?.status;
        if (httpStatus === 409) {
          Alert.alert("Claimed", "Another driver picked this up first.");
          setDeclinedRideIds((prev) => new Set([...prev, ride.rideId]));
        } else {
          Alert.alert("Error", "Could not claim this ride. Try again.");
        }
        void refetchEligible();
      } finally {
        setClaimingRideId(null);
      }
    },
    [claimingRideId, queryClient, router, refetchEligible],
  );

  const handleDecline = useCallback((rideId: string) => {
    setDeclinedRideIds((prev) => new Set([...prev, rideId]));
  }, []);

  // Fill-your-car: add a compatible passenger.
  const handleAddPassenger = useCallback(
    async (requestRideId: string) => {
      if (!activeRide || addingRideId !== null) return;
      setAddingRideId(requestRideId);
      try {
        await addPassenger(activeRide.id, requestRideId);
        void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
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

  // Per-passenger: driver has arrived at this one passenger's pickup. No
  // ride-level effect — only this row updates.
  const handlePassengerArrived = useCallback(
    async (passengerId: string) => {
      if (!activeRide || actingPassengerId !== null) return;
      setActingPassengerId(passengerId);
      try {
        await passengerArrived(activeRide.id, passengerId);
        void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
      } catch {
        Alert.alert("Error", "Could not mark this passenger arrived. Try again.");
      } finally {
        setActingPassengerId(null);
      }
    },
    [activeRide, actingPassengerId, queryClient],
  );

  // Per-passenger: driver has picked up this one passenger. If this is the
  // ride's first pickup, the ride itself walks to IN_PROGRESS server-side —
  // invalidating driverActiveRide picks that up on the next read, no
  // separate "depart" call needed.
  const handlePassengerPickup = useCallback(
    async (passengerId: string) => {
      if (!activeRide || actingPassengerId !== null) return;
      setActingPassengerId(passengerId);
      try {
        await passengerPickup(activeRide.id, passengerId);
        void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
      } catch {
        Alert.alert("Error", "Could not start pickup. Try again.");
      } finally {
        setActingPassengerId(null);
      }
    },
    [activeRide, actingPassengerId, queryClient],
  );

  // Per-passenger: driver has dropped off this one passenger. If no
  // passenger remains active, the ride completes server-side — show a brief
  // summary, then let the driver head back to the online list.
  const handlePassengerDropoff = useCallback(
    async (passengerId: string) => {
      if (!activeRide || actingPassengerId !== null) return;
      setActingPassengerId(passengerId);
      try {
        const result = await passengerDropoff(activeRide.id, passengerId);
        if (result.ride.status === "COMPLETED") {
          setCompletedSummary({ occupancy: result.ride.occupancy });
        }
        void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
      } catch {
        Alert.alert("Error", "Could not drop off this passenger. Try again.");
      } finally {
        setActingPassengerId(null);
      }
    },
    [activeRide, actingPassengerId, queryClient],
  );

  const handleDoneWithCompletedRide = useCallback(() => {
    setCompletedSummary(null);
    void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
  }, [queryClient]);

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
  const toggling = availabilityMutation.isPending;

  // ─── Brief completion summary (last dropoff just completed the ride) ───────

  if (completedSummary) {
    return (
      <Screen>
        <View style={fillStyles.completionWrap}>
          <Ionicons name="checkmark-circle" size={72} color={colors.primary[500]} />
          <Text variant="h2" style={fillStyles.completionTitle}>Ride complete</Text>
          <Text variant="bodySmall" color="muted" style={fillStyles.completionBody}>
            All {completedSummary.occupancy} rider{completedSummary.occupancy !== 1 ? "s" : ""} dropped off.
          </Text>
          <Button label="Back to online list" onPress={handleDoneWithCompletedRide} fullWidth />
        </View>
      </Screen>
    );
  }

  // ─── Fill-your-car mode (SHARED: assembling, then driving) ──────────────────

  if (filling && activeRide) {
    return (
      <Screen scroll>
        <View style={styles.header}>
          <View>
            <Text variant="bodySmall" color="muted">{assembling ? "Assembling" : "Driving"}</Text>
            <Text variant="h1">Your car</Text>
          </View>
          <Pressable
            onPress={() =>
              Alert.alert("Sign out?", "", [
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
          actingPassengerId={actingPassengerId}
          onAddPassenger={(rideId) => void handleAddPassenger(rideId)}
          onPassengerArrived={(passengerId) => void handlePassengerArrived(passengerId)}
          onPassengerPickup={(passengerId) => void handlePassengerPickup(passengerId)}
          onPassengerDropoff={(passengerId) => void handlePassengerDropoff(passengerId)}
        />
      </Screen>
    );
  }

  // ─── Normal home (6b-1 eligible-rides list) ──────────────────────────────────

  const visibleRides = rawEligibleRides.filter((r) => !declinedRideIds.has(r.rideId));
  const sortKey: keyof EligibleRideItem =
    sortBy === "pickup" ? "pickupZoneName" : "dropoffZoneName";

  const loneRides = [...visibleRides.filter((r) => r.type === "LONE")].sort((a, b) =>
    (a[sortKey] as string).localeCompare(b[sortKey] as string),
  );
  const sharedRides = [...visibleRides.filter((r) => r.type === "SHARED")].sort((a, b) =>
    (a[sortKey] as string).localeCompare(b[sortKey] as string),
  );

  return (
    <Screen scroll>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text variant="bodySmall" color="muted">Welcome back</Text>
          <Text variant="h1">{firstName}</Text>
        </View>
        <Pressable
          onPress={() =>
            Alert.alert("Sign out?", "", [
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

      {/* Online/Offline toggle card */}
      <Card style={styles.statusCard}>
        <View style={styles.statusRow}>
          <View style={styles.statusTextCol}>
            <View style={styles.statusDotRow}>
              <View style={[styles.statusDot, isOnline ? styles.dotOnline : styles.dotOffline]} />
              <Text variant="h3">{isOnline ? "Online" : "Offline"}</Text>
            </View>
            <Text variant="bodySmall" color="muted">
              {isOnline
                ? "You're visible to riders. Browse and accept trips below."
                : "Go online to start receiving trip requests."}
            </Text>
          </View>
          <Switch
            value={isOnline}
            onValueChange={() => void handleToggle()}
            disabled={toggling}
            trackColor={{ false: colors.ink[100], true: colors.primary[200] }}
            thumbColor={isOnline ? colors.primary[500] : colors.ink[300]}
            accessibilityLabel="Online toggle"
          />
        </View>
      </Card>

      {/* Offline: empty state */}
      {!isOnline && (
        <View style={styles.emptyState}>
          <Ionicons name="car-outline" size={64} color={colors.ink[200]} />
          <Text variant="h3" style={styles.emptyTitle}>Ready when you are</Text>
          <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
            Toggle online above to start accepting trips around campus.
          </Text>
        </View>
      )}

      {/* Online: sort toggle + sectioned list */}
      {isOnline && (
        <>
          <View style={styles.sortRow}>
            <Text variant="label" color="muted">SORT BY</Text>
            <View style={styles.sortPill}>
              <Pressable
                onPress={() => setSortBy("pickup")}
                style={[styles.sortBtn, sortBy === "pickup" && styles.sortBtnActive]}
              >
                <Text
                  variant="bodySmall"
                  style={sortBy === "pickup" ? styles.sortBtnTextActive : styles.sortBtnText}
                >
                  Pickup
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setSortBy("dropoff")}
                style={[styles.sortBtn, sortBy === "dropoff" && styles.sortBtnActive]}
              >
                <Text
                  variant="bodySmall"
                  style={sortBy === "dropoff" ? styles.sortBtnTextActive : styles.sortBtnText}
                >
                  Dropoff
                </Text>
              </Pressable>
            </View>
          </View>

          {loneRides.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="LONE REQUESTS" count={loneRides.length} />
              {loneRides.map((ride) => (
                <RequestCard
                  key={ride.rideId}
                  ride={ride}
                  claiming={claimingRideId === ride.rideId}
                  onAccept={() => void handleAccept(ride)}
                  onDecline={() => handleDecline(ride.rideId)}
                />
              ))}
            </View>
          )}

          {sharedRides.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="SHARED REQUESTS" count={sharedRides.length} />
              {sharedRides.map((ride) => (
                <RequestCard
                  key={ride.rideId}
                  ride={ride}
                  claiming={claimingRideId === ride.rideId}
                  onAccept={() => void handleAccept(ride)}
                  onDecline={() => handleDecline(ride.rideId)}
                />
              ))}
            </View>
          )}

          {loneRides.length === 0 && sharedRides.length === 0 && (
            <View style={styles.emptyList}>
              <Ionicons name="radio-outline" size={48} color={colors.ink[200]} />
              <Text variant="h3" style={styles.emptyTitle}>Waiting for requests</Text>
              <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
                Ride requests near your zone will appear here.
              </Text>
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
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
  statusCard: { marginBottom: spacing.xl },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  statusTextCol: { flex: 1, gap: spacing.xs },
  statusDotRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
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
  emptyList: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingVertical: spacing["4xl"],
  },
  emptyTitle: { marginTop: spacing.sm },
  emptyBody: { textAlign: "center", maxWidth: 260 },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  sortPill: {
    flexDirection: "row",
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.full,
    padding: 3,
    gap: 2,
  },
  sortBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radii.full },
  sortBtnActive: { backgroundColor: colors.white, ...shadows.sm },
  sortBtnText: { color: colors.ink[500] },
  sortBtnTextActive: { color: colors.ink[900], fontWeight: "600" as const },
  section: { gap: spacing.md, marginBottom: spacing.xl },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.xs,
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
  requestCard: { gap: spacing.md },
  bestMatchBadge: { alignSelf: "flex-start" },
  routeRow: { paddingVertical: spacing.xs },
  zoneBlock: { gap: 2 },
  fareStrip: {
    flexDirection: "row",
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  fareStripItem: { flex: 1, gap: 2, alignItems: "center" },
  earnText: { color: colors.primary[600] },
  cardActions: { flexDirection: "row", gap: spacing.sm },
  declineWrap: { flex: 1 },
  acceptWrap: { flex: 2 },
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
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  passengerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  passengerMarkerCol: { width: 16, alignItems: "center", gap: 1, paddingTop: 2 },
  passengerPickupDot: {
    width: 8, height: 8, borderRadius: radii.full, backgroundColor: colors.primary[400],
  },
  passengerConnector: { width: 1, height: 16, backgroundColor: colors.border },
  passengerTextCol: { flex: 1, gap: 2 },
  passengerActionCol: { alignItems: "flex-end", justifyContent: "center" },
  noPassengersNote: { textAlign: "center", paddingVertical: spacing.sm },
  // Completion summary
  completionWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  completionTitle: { textAlign: "center" },
  completionBody: { textAlign: "center", marginBottom: spacing.md },
  // Suggestions
  suggestionsSection: { marginTop: spacing.sm },
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
    paddingVertical: spacing.xl,
  },
  // Suggestion card
  suggestionCard: { gap: spacing.sm, marginBottom: spacing.md },
  suggBadge: { alignSelf: "flex-start" },
});
