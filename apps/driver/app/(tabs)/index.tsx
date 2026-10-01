import { useEffect } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { StyleSheet, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Illustration,
  LoadingState,
  PressableScale,
  Screen,
  Text,
  colors,
  radii,
  getDriverActiveRide,
  shadows,
  spacing,
  typography,
  useAuth,
} from "@rida/mobile-shared";
import { driverActiveRideQueryKey, markTripOpened, tripStatusLine, wasTripOpened } from "../../lib/activeTrip";
import { useDriverPresence } from "../../lib/presence";
import { useRequestsNearYou } from "../../lib/requests";

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function DriverHomeScreen() {
  const router = useRouter();
  const { isLoading: authLoading, isAuthenticated, user } = useAuth();

  const { isOnline, waking, outsideServiceArea, toggle } = useDriverPresence();

  const { data: activeRide, isLoading: rideLoading } = useQuery({
    queryKey: driverActiveRideQueryKey,
    queryFn: getDriverActiveRide,
    enabled: isAuthenticated,
    refetchInterval: 15_000,
  });

  // "Requests near you (N)" — not while on ANY trip: a driver with an active
  // ride can't claim another (the server refuses).
  const { data: requests = [] } = useRequestsNearYou(isOnline && !activeRide);

  // Open the trip screen once per trip — Ride alone and Shared alike. PUSH,
  // not replace, so the tabs stay underneath; once per trip, so a driver who
  // steps back to Home isn't bounced straight back (the "Return to trip" card
  // and the banner on every tab are how they return).
  useEffect(() => {
    if (!activeRide || wasTripOpened(activeRide.id)) return;
    markTripOpened(activeRide.id);
    router.push(`/ride/${activeRide.id}`);
  }, [activeRide, router]);

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

  // ─── On a trip, stepped back to Home ─────────────────────────────────────
  // Every trip is driven on its own screen; Home says so and leads back.
  if (activeRide) {
    return (
      <Screen>
        <View style={styles.onTrip}>
          <Illustration name="carIdle" size={140} float />
          <Text variant="h2" style={styles.onTripText}>
            You&apos;re on a trip
          </Text>
          <Text variant="bodySmall" color="muted" style={styles.onTripText}>
            {tripStatusLine(activeRide)}
          </Text>
          <Button label="Return to trip" size="lg" onPress={() => router.push(`/ride/${activeRide.id}`)} />
        </View>
      </Screen>
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
      ) : outsideServiceArea ? (
        <View style={styles.emptyState} accessibilityLiveRegion="polite">
          <Illustration name="searchEmpty" size={160} accessibilityLabel="Map" />
          <Text variant="h3" style={styles.emptyTitle}>You&apos;re outside the CampusRide area</Text>
          <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
            Requests reach drivers within 2 km of campus. Head back towards campus and they&apos;ll start coming in.
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
