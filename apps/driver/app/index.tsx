import { useCallback, useEffect, useState } from "react";
import { Redirect, useRouter } from "expo-router";
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
  shadows,
  spacing,
  useAuth,
} from "@rida/mobile-shared";
import type { EligibleRideItem } from "@rida/mobile-shared";

type DriverStatus = "offline" | "online" | "on_ride";
type SortBy = "pickup" | "dropoff";

function timeAgo(isoDate: string): string {
  const diffSecs = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  return `${Math.floor(diffSecs / 60)}m ago`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

      {/* Route */}
      <View style={styles.routeRow}>
        <View style={styles.markerCol}>
          <View style={styles.pickupDot} />
          <View style={styles.routeConnector} />
          <Ionicons name="location" size={14} color={colors.ink[700]} />
        </View>
        <View style={styles.routeTextCol}>
          <View style={styles.zoneBlock}>
            <Text variant="label" color="muted">PICKUP</Text>
            <Text variant="bodyMedium">{ride.pickupZoneName}</Text>
          </View>
          <View style={styles.zoneBlock}>
            <Text variant="label" color="muted">DROPOFF</Text>
            <Text variant="bodyMedium">{ride.dropoffZoneName}</Text>
          </View>
        </View>
      </View>

      {/* Fare strip */}
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

      {/* Actions */}
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

  // Eligible-rides list — polled every 10 s when online.
  const { data: rawEligibleRides = [], refetch: refetchEligible } = useQuery({
    queryKey: ["eligibleRides"],
    queryFn: getEligibleRides,
    enabled: isAuthenticated && isOnline,
    refetchInterval: 10_000,
  });

  // If there's already an active ride (from a previous session or a race), redirect.
  useEffect(() => {
    if (activeRide) {
      router.replace(`/ride/${activeRide.id}`);
    }
  }, [activeRide, router]);

  // Socket: when a new broadcast arrives, immediately refresh the eligible list.
  // The list is the primary surface — the old single-modal is no longer used.
  useEffect(() => {
    if (!isOnline || !isAuthenticated) return;
    const socket = getRideSocket();
    const onBroadcast = () => {
      void refetchEligible();
    };
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [isOnline, isAuthenticated, refetchEligible]);

  const availabilityMutation = useMutation({
    mutationFn: ({ isOnline: on, zoneId }: { isOnline: boolean; zoneId?: string }) =>
      setDriverAvailability(on, zoneId),
    onSuccess: (_data, vars) => {
      setStatus(vars.isOnline ? "online" : "offline");
      if (!vars.isOnline) {
        // Clear local declined list when going offline so it resets on the next session.
        setDeclinedRideIds(new Set());
      }
      void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
      void queryClient.invalidateQueries({ queryKey: ["eligibleRides"] });
    },
    onError: () => {
      Alert.alert(
        "Error",
        "Could not update availability. Make sure your account is approved.",
      );
    },
  });

  const handleToggle = useCallback(async () => {
    if (status === "offline") {
      const { status: permStatus } = await Location.requestForegroundPermissionsAsync();
      if (permStatus !== "granted") {
        Alert.alert(
          "Location required",
          "Enable location so we can match you with nearby riders.",
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const zoneList = zones ?? [];
      const zone = nearestZone(pos.coords.latitude, pos.coords.longitude, zoneList);
      availabilityMutation.mutate({ isOnline: true, zoneId: zone?.id });
    } else {
      availabilityMutation.mutate({ isOnline: false });
    }
  }, [status, zones, availabilityMutation]);

  const handleAccept = useCallback(
    async (rideId: string) => {
      if (claimingRideId !== null) return;
      setClaimingRideId(rideId);
      try {
        await driverClaimRide(rideId);
        void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
        router.push(`/ride/${rideId}`);
      } catch (err) {
        const httpStatus = (err as { response?: { status?: number } }).response?.status;
        if (httpStatus === 409) {
          Alert.alert("Claimed", "Another driver picked this up first.");
          setDeclinedRideIds((prev) => new Set([...prev, rideId]));
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

  // ─── Loading / auth guards ──────────────────────────────────────────────────

  if (authLoading || rideLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/phone" />;
  }

  if (!user.driver || !user.driver.carMake) {
    return <Redirect href="/onboarding" />;
  }

  // ─── Derive list data ────────────────────────────────────────────────────────

  const firstName = user.name?.split(" ")[0] ?? "Driver";
  const toggling = availabilityMutation.isPending;

  const visibleRides = rawEligibleRides.filter((r) => !declinedRideIds.has(r.rideId));
  const sortKey: keyof EligibleRideItem =
    sortBy === "pickup" ? "pickupZoneName" : "dropoffZoneName";

  const loneRides = [...visibleRides.filter((r) => r.type === "LONE")].sort((a, b) =>
    (a[sortKey] as string).localeCompare(b[sortKey] as string),
  );
  const sharedRides = [...visibleRides.filter((r) => r.type === "SHARED")].sort((a, b) =>
    (a[sortKey] as string).localeCompare(b[sortKey] as string),
  );

  // ─── Render ─────────────────────────────────────────────────────────────────

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
          <Text variant="h3" color="inverse">
            {firstName.charAt(0).toUpperCase()}
          </Text>
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

      {/* ── OFFLINE: empty state ─────────────────────────────────────────────── */}
      {!isOnline && (
        <View style={styles.emptyState}>
          <Ionicons name="car-outline" size={64} color={colors.ink[200]} />
          <Text variant="h3" style={styles.emptyTitle}>Ready when you are</Text>
          <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
            Toggle online above to start accepting trips around campus.
          </Text>
        </View>
      )}

      {/* ── ONLINE: request list ─────────────────────────────────────────────── */}
      {isOnline && (
        <>
          {/* Sort toggle */}
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

          {/* Lone requests */}
          {loneRides.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="LONE REQUESTS" count={loneRides.length} />
              {loneRides.map((ride) => (
                <RequestCard
                  key={ride.rideId}
                  ride={ride}
                  claiming={claimingRideId === ride.rideId}
                  onAccept={() => void handleAccept(ride.rideId)}
                  onDecline={() => handleDecline(ride.rideId)}
                />
              ))}
            </View>
          )}

          {/* Shared requests */}
          {sharedRides.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="SHARED REQUESTS" count={sharedRides.length} />
              {sharedRides.map((ride) => (
                <RequestCard
                  key={ride.rideId}
                  ride={ride}
                  claiming={claimingRideId === ride.rideId}
                  onAccept={() => void handleAccept(ride.rideId)}
                  onDecline={() => handleDecline(ride.rideId)}
                />
              ))}
            </View>
          )}

          {/* Empty list state */}
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
  // Layout
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
  // Status card
  statusCard: {
    marginBottom: spacing.xl,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  statusTextCol: {
    flex: 1,
    gap: spacing.xs,
  },
  statusDotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
  },
  dotOnline: { backgroundColor: colors.primary[500] },
  dotOffline: { backgroundColor: colors.ink[300] },
  // Empty states
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
  // Sort control
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
  sortBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  sortBtnActive: {
    backgroundColor: colors.white,
    ...shadows.sm,
  },
  sortBtnText: { color: colors.ink[500] },
  sortBtnTextActive: { color: colors.ink[900], fontWeight: "600" as const },
  // Sections
  section: {
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
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
  // Request card
  requestCard: { gap: spacing.md },
  bestMatchBadge: { alignSelf: "flex-start" },
  routeRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  markerCol: {
    width: 20,
    alignItems: "center",
    gap: 2,
    paddingTop: 14,
  },
  pickupDot: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
  },
  routeConnector: {
    width: 2,
    height: 28,
    backgroundColor: colors.border,
  },
  routeTextCol: {
    flex: 1,
    gap: spacing.md,
  },
  zoneBlock: { gap: 2 },
  fareStrip: {
    flexDirection: "row",
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  fareStripItem: {
    flex: 1,
    gap: 2,
    alignItems: "center",
  },
  earnText: { color: colors.primary[600] },
  cardActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  declineWrap: { flex: 1 },
  acceptWrap: { flex: 2 },
});
