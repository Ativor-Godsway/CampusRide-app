import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, StyleSheet, View } from "react-native";
import * as Updates from "expo-updates";
import { LAUNCH_UPDATE_MAX_MS, launchUpdateStep, withinLaunchBudget, type AppKind } from "@rida/shared";
import { Text, colors, illustrations, spacing } from "../design";

/**
 * Faster updates (@rida/shared config/launchUpdate.ts): once per FRESH
 * launch — this module's state is reset by a launch or a reload, not by a
 * return from the background — ask EAS Update for a newer bundle. Found and
 * no ride going on: "Updating…" for at most LAUNCH_UPDATE_MAX_MS, then reload
 * into it (too slow or offline: carry on, it applies next launch). A ride
 * going on: download only, never reload. Render once in the root layout.
 */

let checkedThisLaunch = false;

/** Tests only. */
export function resetLaunchUpdateForTests(): void {
  checkedThisLaunch = false;
}

/** `work`, or "timeout" after `ms` — whichever comes first; the timer never outlives the race. */
function within<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export interface LaunchUpdateGateProps {
  app: AppKind;
  /** Whether a request or trip is going on now (asked only when an update is found). Errors count as "yes": never risk a reload mid-trip. */
  isRideActive: () => Promise<boolean>;
}

export function LaunchUpdateGate({ app, isRideActive }: LaunchUpdateGateProps) {
  const [updating, setUpdating] = useState(false);
  const rideActive = useRef(isRideActive);
  rideActive.current = isRideActive;

  useEffect(() => {
    if (checkedThisLaunch) return;
    checkedThisLaunch = true;
    const updatesEnabled = Updates.isEnabled && !__DEV__;
    if (!updatesEnabled) return;
    const startedAt = Date.now();
    let cancelled = false;
    void (async () => {
      try {
        const check = await within(Updates.checkForUpdateAsync(), LAUNCH_UPDATE_MAX_MS);
        if (check === "timeout" || !check.isAvailable) return;
        const active = await rideActive.current().catch(() => true);
        const step = launchUpdateStep({ updatesEnabled, available: true, rideActive: active });
        if (step === "next-launch") {
          // expo-updates uses a downloaded bundle from the next launch.
          void Updates.fetchUpdateAsync().catch(() => undefined);
          return;
        }
        if (!withinLaunchBudget(startedAt, Date.now())) {
          void Updates.fetchUpdateAsync().catch(() => undefined);
          return;
        }
        if (!cancelled) setUpdating(true);
        const fetched = await within(Updates.fetchUpdateAsync(), LAUNCH_UPDATE_MAX_MS - (Date.now() - startedAt));
        if (fetched !== "timeout" && fetched.isNew && withinLaunchBudget(startedAt, Date.now())) {
          await Updates.reloadAsync();
          return;
        }
      } catch {
        // Offline, or the update server is down: this version carries on.
      }
      if (!cancelled) setUpdating(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [app]);

  if (!updating) return null;
  return (
    <View style={styles.overlay} accessibilityViewIsModal accessibilityLiveRegion="polite" testID="launch-updating">
      <Image source={illustrations.logoMark} style={styles.logo} accessibilityIgnoresInvertColors />
      <Text variant="title3" style={styles.text}>
        Updating…
      </Text>
      <Text variant="subhead" color="secondary" style={styles.text}>
        Getting the latest CampusRide. This takes a few seconds.
      </Text>
      <ActivityIndicator color={colors.green500} style={styles.spinner} />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing[6],
    zIndex: 1000,
    elevation: 1000,
  },
  logo: { width: 72, height: 72, marginBottom: spacing[5] },
  text: { textAlign: "center", marginTop: spacing[2] },
  spinner: { marginTop: spacing[5] },
});
