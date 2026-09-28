import { useCallback, useEffect, useState } from "react";
import { Redirect, useRouter } from "expo-router";
import { AppState, Image, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Badge,
  Button,
  Card,
  Illustration,
  LoadingState,
  Screen,
  Text,
  colors,
  radii,
  spacing,
  useAuth,
} from "@rida/mobile-shared";
import { SignOutLink } from "../components/SignOutLink";
import { driverSetupRoute } from "../lib/driverGate";

/** How often the screen re-checks approval while it is open. */
const POLL_MS = 30_000;

/**
 * Shown after a driver submits onboarding, until an admin approves them.
 * Re-checks their status on pull-to-refresh, whenever the app comes back to
 * the foreground, and every 30 seconds while open — and moves them into the
 * app the moment they are approved.
 */
export default function PendingApprovalScreen() {
  const router = useRouter();
  const { isLoading, isAuthenticated, user, refreshMe } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const check = useCallback(async () => {
    try {
      await refreshMe();
      setCheckFailed(false);
      setLastChecked(new Date());
    } catch {
      // A rejected session is handled by AuthContext (it signs out and the
      // redirect below fires); anything else is a connection problem.
      setCheckFailed(true);
    }
  }, [refreshMe]);

  useEffect(() => {
    const interval = setInterval(() => void check(), POLL_MS);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void check();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [check]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await check();
    setRefreshing(false);
  }, [check]);

  if (isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }
  if (!isAuthenticated || !user) return <Redirect href="/auth/phone" />;
  if (user.role !== "DRIVER") return <Redirect href="/" />;

  // Approved (→ into the app) or somehow incomplete (→ onboarding): the start
  // screen's gate decides which.
  if (driverSetupRoute(user) !== "/pending") return <Redirect href="/" />;

  const driver = user.driver!;

  return (
    <Screen noPadding>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.primary[500]}
            colors={[colors.primary[500]]}
          />
        }
      >
        <View style={styles.header}>
          <Illustration name="driverOnboarding" size={150} float style={styles.hero} />
          <Badge label="Under review" variant="warning" style={styles.badge} />
          <Text variant="h1">Waiting for approval</Text>
          <Text variant="body" color="muted">
            Thanks, {user.name.split(" ")[0]}! An admin will review your photo and car details. Once
            you&apos;re approved, this screen will take you straight into the app so you can go
            online and start accepting rides.
          </Text>
        </View>

        <Card style={styles.summary}>
          <View style={styles.summaryRow}>
            {driver.photoUrl ? (
              <Image source={{ uri: driver.photoUrl }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoPlaceholder]}>
                <Ionicons name="person" size={24} color={colors.primary[300]} />
              </View>
            )}
            <View style={styles.summaryText}>
              <Text variant="bodyMedium">{user.name}</Text>
              <Text variant="bodySmall" color="muted">
                {[driver.carColor, driver.carMake, driver.carModel].filter(Boolean).join(" ")}
              </Text>
              <Text variant="bodySmall" color="muted">
                {driver.plate}
              </Text>
            </View>
          </View>
        </Card>

        <View style={styles.status}>
          <Ionicons
            name={checkFailed ? "cloud-offline-outline" : "time-outline"}
            size={16}
            color={checkFailed ? colors.error : colors.ink[400]}
          />
          <Text variant="caption" color={checkFailed ? "error" : "muted"}>
            {checkFailed
              ? "Couldn't check your status. Pull down to try again."
              : lastChecked
                ? `Last checked at ${lastChecked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Pull down to refresh.`
                : "Pull down to check your status."}
          </Text>
        </View>

        <View style={styles.actions}>
          <Button label="Check status now" onPress={() => void onRefresh()} loading={refreshing} />
          <Button
            label="Edit my details"
            variant="secondary"
            onPress={() => router.push("/onboarding")}
          />
        </View>

        <SignOutLink />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, paddingBottom: spacing["3xl"], flexGrow: 1 },
  header: { gap: spacing.sm, marginBottom: spacing.xl },
  hero: { alignSelf: "center", marginBottom: spacing.md },
  badge: { marginBottom: spacing.xs },
  summary: { marginBottom: spacing.md },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  photo: { width: 56, height: 56, borderRadius: radii.full },
  photoPlaceholder: {
    backgroundColor: colors.primary[50],
    alignItems: "center",
    justifyContent: "center",
  },
  summaryText: { flex: 1, gap: 2 },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.xl,
  },
  actions: { gap: spacing.md },
});
