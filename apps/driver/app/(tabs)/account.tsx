import { Alert, Image, StyleSheet, View } from "react-native";
import { Badge, Card, ListRow, Screen, Text, colors, radii, spacing, useAuth } from "@rida/mobile-shared";

/** Account tab — driver profile, car details from onboarding, approval status, and sign out. */
export default function AccountTab() {
  const { user, signOut } = useAuth();
  const driver = user?.driver;

  const confirmLogout = () => {
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void signOut() },
    ]);
  };

  return (
    <Screen scroll style={styles.content}>
      <View style={styles.header}>
        {driver?.photoUrl ? (
          <Image source={{ uri: driver.photoUrl }} style={styles.avatarImage} />
        ) : (
          <View style={styles.avatar}>
            <Text variant="h2" color="inverse">
              {user?.name?.charAt(0).toUpperCase() ?? "?"}
            </Text>
          </View>
        )}
        <View style={styles.profileInfo}>
          <Text variant="h2">{user?.name ?? "Driver"}</Text>
          <Text variant="bodySmall" color="muted">
            {user?.phone}
          </Text>
        </View>
      </View>

      <Badge
        label={driver?.isApproved ? "Approved" : "Pending approval"}
        variant={driver?.isApproved ? "success" : "warning"}
        style={styles.approvalBadge}
      />

      <Text variant="label" color="muted" style={styles.sectionLabel}>
        CAR DETAILS
      </Text>
      <Card>
        <ListRow
          title="Make"
          trailing={<Text variant="bodyMedium">{driver?.carMake ?? "—"}</Text>}
          showChevron={false}
        />
        <View style={styles.divider} />
        <ListRow
          title="Model"
          trailing={<Text variant="bodyMedium">{driver?.carModel ?? "—"}</Text>}
          showChevron={false}
        />
        <View style={styles.divider} />
        <ListRow
          title="Color"
          trailing={<Text variant="bodyMedium">{driver?.carColor ?? "—"}</Text>}
          showChevron={false}
        />
        <View style={styles.divider} />
        <ListRow
          title="Plate"
          trailing={<Text variant="bodyMedium">{driver?.plate ?? "—"}</Text>}
          showChevron={false}
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
  avatarImage: {
    width: 60,
    height: 60,
    borderRadius: radii.full,
  },
  profileInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  approvalBadge: {
    alignSelf: "flex-start",
    marginBottom: spacing.xl,
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
