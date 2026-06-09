import { Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, ListRow, Screen, Text, colors, radii, spacing, useAuth } from "@rida/mobile-shared";

/** Account tab — profile summary, basic settings, and logout. */
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
        <Text variant="h1">Account</Text>
      </View>

      <Card style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text variant="h2" color="inverse">
            {user?.name?.charAt(0).toUpperCase() ?? "?"}
          </Text>
        </View>
        <View style={styles.profileInfo}>
          <Text variant="h3">{user?.name ?? "Rider"}</Text>
          <Text variant="bodySmall" color="muted">
            {user?.phone}
          </Text>
        </View>
      </Card>

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
    marginBottom: spacing.xl,
  },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    marginBottom: spacing["2xl"],
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
    alignItems: "center",
    justifyContent: "center",
  },
  profileInfo: {
    flex: 1,
    gap: spacing.xs,
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
