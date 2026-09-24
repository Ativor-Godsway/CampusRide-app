import { useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Card,
  ListRow,
  Screen,
  ServiceIcon,
  Text,
  colors,
  confirmDeleteAccount,
  describeDeleteAccountError,
  radii,
  spacing,
  useAuth,
} from "@rida/mobile-shared";

interface QuickAction {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Route to open; tiles without one are still placeholders. */
  href?: "/safety";
}

// No Wallet tile: CampusRide is cash-only for now (digital payment is
// disabled server-side), so there is no balance to show and no stub to leave.
const QUICK_ACTIONS: QuickAction[] = [
  { label: "Help", icon: "help-buoy-outline" },
  // Phase 4: a real screen now — the rider's emergency contact, which the
  // in-ride SOS button uses.
  { label: "Safety", icon: "shield-checkmark-outline", href: "/safety" },
  { label: "Inbox", icon: "mail-outline" },
];

/** Account tab — profile header, Uber-style quick-action grid, settings list, and logout. */
export default function AccountTab() {
  const router = useRouter();
  const { user, signOut, deleteAccount } = useAuth();
  const hasEmergencyContact = Boolean(user?.emergencyContactName && user?.emergencyContactPhone);

  const confirmLogout = () => {
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void signOut() },
    ]);
  };

  // Permanent account closure, required for app-store compliance and the
  // only in-app way to leave. Two-step confirmation lives in mobile-shared
  // so rider and driver ask identically.
  const startDeleteAccount = () =>
    confirmDeleteAccount({
      deleteAccount,
      onError: (error) => Alert.alert("Couldn't delete account", describeDeleteAccountError(error)),
    });

  const showComingSoon = (label: string) =>
    Alert.alert(`${label} is coming soon`, "We're working on it — check back in a future update.");

  return (
    <Screen scroll style={styles.content}>
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text variant="h2" color="inverse">
            {user?.name?.charAt(0).toUpperCase() ?? "?"}
          </Text>
        </View>
        <View style={styles.profileInfo}>
          <Text variant="h2">{user?.name ?? "Rider"}</Text>
          <Text variant="bodySmall" color="muted">
            {user?.phone}
          </Text>
        </View>
      </View>

      <View style={styles.quickGrid}>
        {QUICK_ACTIONS.map((action) => (
          <Pressable
            key={action.label}
            style={styles.quickTilePressable}
            onPress={() => (action.href ? router.push(action.href) : showComingSoon(action.label))}
            accessibilityRole="button"
          >
            <Card noPadding style={styles.quickTile}>
              <ServiceIcon name={action.icon} color={colors.primary[600]} background={colors.primary[50]} size={44} />
              <Text variant="bodyMedium" style={styles.quickLabel}>
                {action.label}
              </Text>
            </Card>
          </Pressable>
        ))}
      </View>

      <Text variant="label" color="muted" style={styles.sectionLabel}>
        SETTINGS
      </Text>

      <Card>
        <ListRow
          title="Edit profile"
          leading={<ListRow.Icon name="person-outline" />}
          onPress={() => router.push("/profile")}
        />
        <View style={styles.divider} />
        <ListRow
          title="Emergency contact"
          // Surfaced in Settings too, not just the Safety tile: an unset
          // contact means the SOS button cannot work, so it is worth a
          // visible prompt rather than hiding behind an icon grid.
          subtitle={
            hasEmergencyContact ? (user?.emergencyContactName ?? undefined) : "Not set up yet"
          }
          leading={<ListRow.Icon name="shield-checkmark-outline" />}
          onPress={() => router.push("/safety")}
        />
        <View style={styles.divider} />
        <ListRow
          title="Notifications"
          leading={<ListRow.Icon name="notifications-outline" />}
          onPress={() => showComingSoon("Notification settings")}
        />
        <View style={styles.divider} />
        <ListRow
          title="Help & support"
          leading={<ListRow.Icon name="help-circle-outline" />}
          onPress={() => showComingSoon("Help & support")}
        />
      </Card>

      <Card style={styles.logoutCard}>
        <ListRow
          title="Log out"
          leading={<ListRow.Icon name="log-out-outline" color={colors.error} background={colors.errorSurface} />}
          onPress={confirmLogout}
          showChevron={false}
        />
        <View style={styles.divider} />
        <ListRow
          title="Delete account"
          leading={<ListRow.Icon name="trash-outline" color={colors.error} background={colors.errorSurface} />}
          onPress={startDeleteAccount}
          showChevron={false}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing["4xl"],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    marginBottom: spacing.xl,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
    alignItems: "center",
    justifyContent: "center",
  },
  profileInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  quickGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    marginBottom: spacing["2xl"],
  },
  quickTilePressable: {
    flexBasis: "47%",
    flexGrow: 1,
  },
  quickTile: {
    padding: spacing.lg,
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  quickLabel: {
    marginTop: spacing.xs,
  },
  sectionLabel: {
    marginBottom: spacing.md,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  logoutCard: {
    marginTop: spacing.xl,
  },
});
