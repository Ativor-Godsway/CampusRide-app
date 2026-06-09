import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, ListRow, Screen, ServiceIcon, Text, colors, radii, spacing, useAuth } from "@rida/mobile-shared";

interface QuickAction {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Help", icon: "help-buoy-outline" },
  { label: "Wallet", icon: "wallet-outline" },
  { label: "Safety", icon: "shield-checkmark-outline" },
  { label: "Inbox", icon: "mail-outline" },
];

/** Account tab — profile header, Uber-style quick-action grid, settings list, and logout. */
export default function AccountTab() {
  const { user, signOut } = useAuth();

  const confirmLogout = () => {
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void signOut() },
    ]);
  };

  const showComingSoon = (label: string) =>
    Alert.alert(`${label} is coming soon`, "We're working on it — check back in a future update.");

  return (
    <Screen scroll>
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
            onPress={() => showComingSoon(action.label)}
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
          onPress={() => showComingSoon("Editing your profile")}
        />
        <View style={styles.divider} />
        <ListRow
          title="Payment methods"
          leading={<ListRow.Icon name="card-outline" />}
          onPress={() => showComingSoon("Payment methods")}
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
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
