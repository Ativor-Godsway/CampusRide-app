import { useCallback, useEffect, useState } from "react";
import { Redirect, useRouter } from "expo-router";
import { AppState, Image, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Card,
  Screen,
  Text,
  colors,
  radii,
  spacing,
  useAuth,
  SessionRestoringScreen,
} from "@rida/mobile-shared";
import { clockTime, cloudinaryAvatar } from "@rida/shared";
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

  if (isLoading) return <SessionRestoringScreen />;
  if (!isAuthenticated || !user) return <Redirect href="/auth/welcome" />;
  if (user.role !== "DRIVER") return <Redirect href="/" />;

  // Approved (→ into the app) or somehow incomplete (→ onboarding): the start
  // screen's gate decides which.
  if (driverSetupRoute(user) !== "/pending") return <Redirect href="/" />;

  const driver = user.driver!;
  const car = [driver.carColor, driver.carMake, driver.carModel].filter(Boolean).join(" ");

  return (
    <Screen noPadding edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.green500}
            colors={[colors.green500]}
          />
        }
      >
        <View style={styles.heading}>
          <Text variant="title1" accessibilityRole="header">
            Waiting for approval
          </Text>
          <Text variant="body" color="secondary">
            Thanks, {user.name.split(" ")[0]}. Our team is checking your photo and car details.
          </Text>
        </View>

        <Timeline />

        <Card variant="filled" style={styles.summary}>
          {driver.photoUrl ? (
            <Image source={{ uri: cloudinaryAvatar(driver.photoUrl, 56) }} style={styles.photo} />
          ) : (
            <View style={[styles.photo, styles.photoPlaceholder]}>
              <Ionicons name="person" size={24} color={colors.green500} />
            </View>
          )}
          <View style={styles.summaryText}>
            <Text variant="title3" numberOfLines={2}>
              {user.name}
            </Text>
            {car ? (
              <Text variant="subhead" color="secondary" numberOfLines={2}>
                {car}
              </Text>
            ) : null}
            {driver.plate ? (
              <View style={styles.plateFrame}>
                <Text variant="plate" numberOfLines={1}>
                  {driver.plate}
                </Text>
              </View>
            ) : null}
          </View>
        </Card>

        <Text variant="body">We&apos;ll let you know as soon as you&apos;re approved.</Text>

        <View style={styles.status} accessibilityLiveRegion="polite">
          <Ionicons
            name={checkFailed ? "cloud-offline-outline" : "time-outline"}
            size={16}
            color={checkFailed ? colors.red600 : colors.ink3}
          />
          <Text variant="subhead" color={checkFailed ? "danger" : "secondary"}>
            {checkFailed
              ? "Couldn't check your status. Pull down to try again."
              : lastChecked
                ? `Last checked ${clockTime(lastChecked)}`
                : "Pull down to check your status."}
          </Text>
        </View>

        <View style={styles.actions}>
          <Button label="Check status" onPress={() => void onRefresh()} loading={refreshing} />
          <Button
            label="Edit my details"
            variant="text"
            onPress={() => router.push("/onboarding")}
          />
          <SignOutLink />
        </View>
      </ScrollView>
    </Screen>
  );
}

/** Submitted ✓ → In review → Approved: where the driver is in the process. */
function Timeline() {
  const steps = [
    { label: "Submitted", state: "done" },
    { label: "In review", state: "now" },
    { label: "Approved", state: "next" },
  ] as const;
  return (
    <View
      style={styles.timeline}
      accessible
      accessibilityLabel="Submitted, done. In review, now. Approved, next."
    >
      {steps.map((step, i) => (
        <View key={step.label} style={styles.step}>
          <View style={styles.stepMarker}>
            <View
              style={[
                styles.stepDot,
                step.state === "done" && styles.stepDone,
                step.state === "now" && styles.stepNow,
              ]}
            >
              {step.state === "done" ? (
                <Ionicons name="checkmark" size={14} color={colors.onBrand} />
              ) : null}
            </View>
            {i < steps.length - 1 ? (
              <View style={[styles.stepLine, step.state === "done" && styles.stepLineDone]} />
            ) : null}
          </View>
          <Text
            variant={step.state === "now" ? "bodyStrong" : "body"}
            color={step.state === "next" ? "tertiary" : "default"}
            style={styles.stepLabel}
          >
            {step.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.gutter, paddingTop: spacing[8], gap: spacing[5], flexGrow: 1 },
  heading: { gap: spacing[2] },
  timeline: { gap: 0 },
  step: { flexDirection: "row", gap: spacing[3], minHeight: 44 },
  stepMarker: { alignItems: "center", width: 24 },
  stepDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.surface3,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  stepDone: { borderColor: colors.green500, backgroundColor: colors.green500 },
  stepNow: { borderColor: colors.green500, borderWidth: 6 },
  stepLine: { flex: 1, width: 2, backgroundColor: colors.surface3 },
  stepLineDone: { backgroundColor: colors.green500 },
  stepLabel: { paddingTop: 1 },
  summary: { flexDirection: "row", alignItems: "flex-start", gap: spacing[3] },
  photo: { width: 56, height: 56, borderRadius: radii.full },
  photoPlaceholder: {
    backgroundColor: colors.green50,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryText: { flex: 1, gap: 2 },
  // The plate frame: white, 1.5 ink border, radius-sm (docs/design-system.md).
  plateFrame: {
    alignSelf: "flex-start",
    marginTop: spacing[1],
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
  },
  status: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  actions: { gap: spacing[2], marginTop: "auto" },
});
