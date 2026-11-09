import { useRouter } from "expo-router";
import { PRIVACY_URL, TERMS_URL, formatGhanaPhone, initialsOf, stopLabel } from "@rida/shared";
import { Alert, StyleSheet, View } from "react-native";
import {
  CallSupportRow,
  ListRow,
  Screen,
  Text,
  colors,
  getAppVersionLabel,
  openLegalPage,
  radii,
  showAppAbout,
  spacing,
  useAuth,
} from "@rida/mobile-shared";
import { TAB_SCREEN_BOTTOM_PADDING } from "../../lib/layout";
import { useActiveRide } from "../../lib/activeRide";

/**
 * Account tab: who's signed in, then grouped rows — the account itself
 * (profile, safety, notifications), Call support and the legal pages, and
 * leaving (log out, delete account). About (version, licences) at the bottom.
 */
export default function AccountTab() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const hasEmergencyContact = Boolean(user?.emergencyContactName && user?.emergencyContactPhone);

  const { data: activeRide } = useActiveRide();
  const confirmLogout = () => {
    // Logging out never cancels a ride; say so, so nobody logs out thinking
    // it does (or panics that it did).
    const message = activeRide
      ? `Your ride to ${stopLabel(activeRide.dropoffLabel, activeRide.dropoffZone.name)} is still going on — logging out won't cancel it. Log back in to see it.`
      : "Are you sure you want to log out?";
    Alert.alert("Log out", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void signOut() },
    ]);
  };

  return (
    <Screen scroll edges={["top"]} style={styles.content}>
      {/* Riders have no profile photo, so the avatar is their initial. */}
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text variant="title2" color="brand">
            {initialsOf(user?.name, 1) || "?"}
          </Text>
        </View>
        <View style={styles.profileInfo}>
          <Text variant="title2" numberOfLines={1}>
            {user?.name ?? "Rider"}
          </Text>
          <Text variant="subhead" color="secondary">
            {user?.phone ? formatGhanaPhone(user.phone) : null}
          </Text>
        </View>
      </View>

      <View>
        <ListRow
          title="Profile"
          leading={<ListRow.Icon name="person-outline" />}
          onPress={() => router.push("/profile")}
        />
        <ListRow
          divider
          title="Safety and emergency contacts"
          // An unset contact means an SOS reaches only support: worth saying here.
          subtitle={
            hasEmergencyContact ? (user?.emergencyContactName ?? undefined) : "Not set up yet"
          }
          leading={<ListRow.Icon name="shield-checkmark-outline" />}
          onPress={() => router.push("/safety")}
        />
        <ListRow
          divider
          title="Notifications"
          leading={<ListRow.Icon name="notifications-outline" />}
          onPress={() => router.push("/notifications")}
        />
      </View>

      <View>
        <CallSupportRow />
        <ListRow
          divider
          title="Terms"
          leading={<ListRow.Icon name="document-text-outline" />}
          onPress={() => void openLegalPage(TERMS_URL)}
        />
        <ListRow
          divider
          title="Privacy"
          leading={<ListRow.Icon name="lock-closed-outline" />}
          onPress={() => void openLegalPage(PRIVACY_URL)}
        />
      </View>

      <View>
        <ListRow
          title="Log out"
          leading={<ListRow.Icon name="log-out-outline" />}
          onPress={confirmLogout}
          showChevron={false}
        />
        {/* Its own screen (mobile-shared DeleteAccountScreen) explains what is
            deleted and kept, and confirms with a texted code. */}
        <ListRow
          divider
          tone="danger"
          title="Delete account"
          leading={<ListRow.Icon name="trash-outline" tone="danger" />}
          onPress={() => router.push("/delete-account")}
          showChevron={false}
        />
      </View>

      {/* About: which build this phone runs (docs/runbooks/releasing.md; long-press for the
          build number and update ID) and the licences notice the libraries require. */}
      <View style={styles.about} accessibilityRole="summary">
        <Text variant="caption" color="tertiary" accessibilityRole="header">
          About
        </Text>
        <Text
          variant="caption"
          color="tertiary"
          onLongPress={showAppAbout}
          accessibilityHint="Long-press for the build number and update ID"
        >
          {getAppVersionLabel()}
        </Text>
        <Text variant="caption" color="secondary" accessibilityRole="link" onPress={() => router.push("/licenses")}>
          Open-source licenses
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: TAB_SCREEN_BOTTOM_PADDING,
    gap: spacing[6],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[4],
    marginTop: spacing[2],
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: radii.full,
    backgroundColor: colors.green50,
    alignItems: "center",
    justifyContent: "center",
  },
  profileInfo: {
    flex: 1,
    gap: 2,
  },
  about: {
    alignItems: "center",
    gap: spacing[1],
  },
});
