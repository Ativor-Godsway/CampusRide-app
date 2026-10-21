import { useEffect, useRef } from "react";
import { BackHandler, Linking, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { showUpdateScreen, type AppKind } from "@rida/shared";
import { Button, Screen, Text, colors, radii, spacing } from "../design";
import { useUpdateRequirement } from "./useUpdateRequirement";

const KEEP_DOING: Record<AppKind, string> = { rider: "riding", driver: "driving" };

export interface UpdateRequiredScreenProps {
  app: AppKind;
  /** The store page, or null: the screen says to search the store instead. */
  storeUrl: string | null;
}

/** "Time to update": one action, the store. Nothing on it lets the person past. */
export function UpdateRequiredScreen({ app, storeUrl }: UpdateRequiredScreenProps) {
  return (
    <Screen edges={["top", "bottom"]} style={styles.page}>
      <View style={styles.middle}>
        <View style={styles.icon}>
          <Ionicons name="arrow-up" size={32} color={colors.green500} />
        </View>
        <Text variant="title1" accessibilityRole="header" style={styles.centered}>
          Time to update
        </Text>
        <Text variant="body" color="secondary" style={styles.centered}>
          This version of CampusRide is no longer supported. Update to keep {KEEP_DOING[app]}.
        </Text>
      </View>
      <View style={styles.footer}>
        {storeUrl ? (
          <Button label="Update now" onPress={() => void Linking.openURL(storeUrl).catch(() => undefined)} />
        ) : (
          <Text variant="bodyStrong" style={styles.centered}>
            Search CampusRide in your app store
          </Text>
        )}
      </View>
    </Screen>
  );
}

export interface AppUpdateGateProps {
  app: AppKind;
  /**
   * A trip is going on (or might be): a due screen waits until it's over
   * (holdUpdateScreen in @rida/shared).
   */
  hold: boolean;
  /** Called each time the screen comes up (the driver app goes offline). */
  onShow?: () => void;
}

/**
 * The forced update (docs/runbooks/releasing.md, "Forcing an update"): when
 * the server's minimum for this app and platform is above the installed
 * version, "Time to update" covers every screen and can't be closed — the
 * Android back button does nothing. Render once in the root layout, last.
 */
export function AppUpdateGate({ app, hold, onShow }: AppUpdateGateProps) {
  const requirement = useUpdateRequirement(app);
  const visible = showUpdateScreen(requirement, hold);
  // Called once per showing, not again on every render of the caller.
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;

  useEffect(() => {
    if (!visible) return;
    onShowRef.current?.();
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [visible]);

  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <UpdateRequiredScreen app={app} storeUrl={requirement.storeUrl} />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1100,
    elevation: 1100,
    backgroundColor: colors.surface,
  },
  page: {
    paddingBottom: spacing[4],
  },
  middle: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[2],
  },
  icon: {
    width: 72,
    height: 72,
    borderRadius: radii.full,
    backgroundColor: colors.green50,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing[2],
  },
  centered: {
    textAlign: "center",
  },
  footer: {
    gap: spacing[2],
    minHeight: 56,
    justifyContent: "center",
  },
});
