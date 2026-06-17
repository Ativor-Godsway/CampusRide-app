import { useCallback, useEffect, useRef, useState } from "react";
import { Redirect, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { nearestZone } from "@rida/shared";
import type { RideBroadcastPayload } from "@rida/shared";
import { DRIVER_EVENTS } from "@rida/shared";
import {
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
  shadows,
  spacing,
  useAuth,
} from "@rida/mobile-shared";

type DriverStatus = "offline" | "online" | "on_ride";

export default function DriverHomeScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isLoading: authLoading, isAuthenticated, user, signOut } = useAuth();

  const [status, setStatus] = useState<DriverStatus>("offline");
  const [pendingBroadcast, setPendingBroadcast] = useState<RideBroadcastPayload | null>(null);
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [claiming, setClaiming] = useState(false);

  const { data: zones } = useQuery({ queryKey: ["zones"], queryFn: getZones, enabled: isAuthenticated });
  const { data: activeRide, isLoading: rideLoading } = useQuery({
    queryKey: ["driverActiveRide"],
    queryFn: getDriverActiveRide,
    enabled: isAuthenticated,
    refetchInterval: 15_000,
  });

  // If there's already an active ride, redirect to it.
  useEffect(() => {
    if (activeRide) {
      router.replace(`/ride/${activeRide.id}`);
    }
  }, [activeRide, router]);

  const availabilityMutation = useMutation({
    mutationFn: ({ isOnline, zoneId }: { isOnline: boolean; zoneId?: string }) =>
      setDriverAvailability(isOnline, zoneId),
    onSuccess: (_data, vars) => {
      setStatus(vars.isOnline ? "online" : "offline");
      void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
    },
    onError: () => {
      Alert.alert("Error", "Could not update availability. Make sure your account is approved.");
    },
  });

  const handleToggle = useCallback(async () => {
    if (status === "offline") {
      // Request location permission + get current position to determine zone.
      const { status: permStatus } = await Location.requestForegroundPermissionsAsync();
      if (permStatus !== "granted") {
        Alert.alert(
          "Location required",
          "Enable location so we can match you with nearby riders.",
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const zoneList = zones ?? [];
      const zone = nearestZone(pos.coords.latitude, pos.coords.longitude, zoneList);

      availabilityMutation.mutate({ isOnline: true, zoneId: zone?.id });
    } else {
      // Dismiss any pending broadcast when going offline.
      dismissBroadcast();
      availabilityMutation.mutate({ isOnline: false });
    }
  }, [status, zones, availabilityMutation]);

  // Connect the socket and listen for ride broadcasts when online.
  useEffect(() => {
    if (status !== "online" || !isAuthenticated) return;

    const socket = getRideSocket();

    const onBroadcast = (payload: RideBroadcastPayload) => {
      const ttl = Math.round(Math.max(0, payload.expiresAt - Date.now()) / 1000);
      setPendingBroadcast(payload);
      setCountdown(Math.min(ttl, 20)); // show at most 20s UI countdown
    };

    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [status, isAuthenticated]);

  // Tick the countdown.
  useEffect(() => {
    if (!pendingBroadcast || countdown <= 0) {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      if (pendingBroadcast && countdown <= 0) setPendingBroadcast(null);
      return;
    }
    countdownRef.current = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [pendingBroadcast, countdown]);

  const dismissBroadcast = useCallback(() => {
    setPendingBroadcast(null);
    setCountdown(0);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  const handleClaim = useCallback(async () => {
    if (!pendingBroadcast || claiming) return;
    setClaiming(true);
    try {
      await driverClaimRide(pendingBroadcast.rideId);
      dismissBroadcast();
      void queryClient.invalidateQueries({ queryKey: ["driverActiveRide"] });
      router.push(`/ride/${pendingBroadcast.rideId}`);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        Alert.alert("Too late", "Another driver got there first.");
      } else {
        Alert.alert("Error", "Could not claim this ride. Try again.");
      }
      dismissBroadcast();
    } finally {
      setClaiming(false);
    }
  }, [pendingBroadcast, claiming, dismissBroadcast, queryClient, router]);

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

  // Gate: driver must complete car details before seeing the home screen.
  // user.driver is undefined right after signup (not yet refreshed from /me);
  // user.driver.carMake === null means they signed up but never filled in the form.
  if (!user.driver || !user.driver.carMake) {
    return <Redirect href="/onboarding" />;
  }

  const firstName = user.name?.split(" ")[0] ?? "Driver";
  const isOnline = status === "online" || status === "on_ride";
  const toggling = availabilityMutation.isPending;

  return (
    <Screen>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text variant="bodySmall" color="muted">
            Welcome back
          </Text>
          <Text variant="h1">{firstName}</Text>
        </View>
        <Pressable
          onPress={() => Alert.alert("Sign out?", "", [
            { text: "Cancel", style: "cancel" },
            { text: "Sign out", style: "destructive", onPress: () => void signOut() },
          ])}
          style={styles.avatar}
          accessibilityRole="button"
          accessibilityLabel="Account"
        >
          <Text variant="h3" color="inverse">
            {firstName.charAt(0).toUpperCase()}
          </Text>
        </Pressable>
      </View>

      {/* Online/Offline card */}
      <Card style={styles.statusCard}>
        <View style={styles.statusRow}>
          <View style={styles.statusTextCol}>
            <View style={styles.statusDotRow}>
              <View style={[styles.statusDot, isOnline ? styles.dotOnline : styles.dotOffline]} />
              <Text variant="h3">{isOnline ? "Online" : "Offline"}</Text>
            </View>
            <Text variant="bodySmall" color="muted">
              {isOnline
                ? "You're visible to riders. Wait for a trip request."
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

      {/* Empty state when offline */}
      {!isOnline && (
        <View style={styles.emptyState}>
          <Ionicons name="car-outline" size={64} color={colors.ink[200]} />
          <Text variant="h3" style={styles.emptyTitle}>
            Ready when you are
          </Text>
          <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
            Toggle online above to start accepting trips around campus.
          </Text>
        </View>
      )}

      {/* Waiting indicator when online */}
      {isOnline && (
        <View style={styles.waitingContainer}>
          <Ionicons name="radio-outline" size={48} color={colors.primary[300]} />
          <Text variant="bodyMedium" color="muted" style={styles.waitingText}>
            Waiting for a nearby ride request…
          </Text>
        </View>
      )}

      {/* Incoming ride broadcast modal */}
      <Modal
        visible={pendingBroadcast !== null}
        transparent
        animationType="slide"
        onRequestClose={dismissBroadcast}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.broadcastSheet}>
            {pendingBroadcast && (
              <>
                <View style={styles.broadcastHeader}>
                  <Text variant="h2">New Trip Request</Text>
                  <View style={styles.countdownBadge}>
                    <Text variant="bodySmall" color="inverse">
                      {countdown}s
                    </Text>
                  </View>
                </View>

                <View style={styles.routeRow}>
                  <View style={styles.markerCol}>
                    <View style={styles.pickupDot} />
                    <View style={styles.routeConnector} />
                    <Ionicons name="location" size={16} color={colors.ink[700]} />
                  </View>
                  <View style={styles.routeTextCol}>
                    <View style={styles.zoneBlock}>
                      <Text variant="label" color="muted">PICKUP</Text>
                      <Text variant="bodyMedium">{pendingBroadcast.pickupZoneName}</Text>
                    </View>
                    <View style={styles.zoneBlock}>
                      <Text variant="label" color="muted">DROPOFF</Text>
                      <Text variant="bodyMedium">{pendingBroadcast.dropoffZoneName}</Text>
                    </View>
                  </View>
                </View>

                <View style={styles.fareRow}>
                  <View style={styles.fareItem}>
                    <Text variant="label" color="muted">TYPE</Text>
                    <Text variant="bodyMedium">{pendingBroadcast.type}</Text>
                  </View>
                  <View style={styles.fareItem}>
                    <Text variant="label" color="muted">TOTAL FARE</Text>
                    <Text variant="bodyMedium">{formatGhs(pendingBroadcast.farePesewas)}</Text>
                  </View>
                  <View style={styles.fareItem}>
                    <Text variant="label" color="muted">YOUR EARN</Text>
                    <Text variant="h3" style={styles.earnAmount}>
                      {formatGhs(pendingBroadcast.driverSharePesewas)}
                    </Text>
                  </View>
                </View>

                <View style={styles.broadcastActions}>
                  <Button
                    label={claiming ? "Claiming…" : "Accept Trip"}
                    onPress={() => void handleClaim()}
                    loading={claiming}
                    size="lg"
                  />
                  <Button
                    label="Ignore"
                    variant="secondary"
                    onPress={dismissBroadcast}
                    size="lg"
                  />
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

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
  dotOnline: {
    backgroundColor: colors.primary[500],
  },
  dotOffline: {
    backgroundColor: colors.ink[300],
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingBottom: spacing["4xl"],
  },
  emptyTitle: {
    marginTop: spacing.sm,
  },
  emptyBody: {
    textAlign: "center",
    maxWidth: 260,
  },
  waitingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    paddingBottom: spacing["4xl"],
  },
  waitingText: {
    textAlign: "center",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  broadcastSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: spacing.xl,
    gap: spacing.lg,
    ...shadows.lg,
  },
  broadcastHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  countdownBadge: {
    backgroundColor: colors.accent[500],
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minWidth: 40,
    alignItems: "center",
  },
  routeRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.sm,
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
  zoneBlock: {
    gap: 2,
  },
  fareRow: {
    flexDirection: "row",
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  fareItem: {
    flex: 1,
    gap: 2,
    alignItems: "center",
  },
  earnAmount: {
    color: colors.primary[600],
  },
  broadcastActions: {
    gap: spacing.sm,
  },
});
