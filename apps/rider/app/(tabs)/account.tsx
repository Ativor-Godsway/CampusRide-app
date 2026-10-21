import { useRouter } from "expo-router";
import { PRIVACY_URL, TERMS_URL, WEBSITE_URL, stopLabel } from "@rida/shared";
import { Alert, StyleSheet, View } from "react-native";
import {
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

const SUPPORT_URL = `${WEBSITE_URL}/support`;

/**
 * Account tab: who's signed in, then grouped rows — the account itself
 * (profile, safety, notifications), help and the legal pages, and leaving
 * (log out, delete account). The app's version is at the bottom.
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
            {user?.name?.trim().charAt(0).toUpperCase() || "?"}
          </Text>
        </View>
        <View style={styles.profileInfo}>
          <Text variant="title2" numberOfLines={1}>
            {user?.name ?? "Rider"}
          </Text>
          <Text variant="subhead" color="secondary">
            {user?.phone}
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
        <ListRow
          title="Help and support"
          leading={<ListRow.Icon name="help-circle-outline" />}
          onPress={() => void openLegalPage(SUPPORT_URL)}
        />
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

      {/* Dev builds only: every design-system component, to compare with docs/design-system.md. */}
      {__DEV__ ? (
        <ListRow
          title="Design gallery"
          subtitle="Dev only: components and text styles"
          leading={<ListRow.Icon name="color-palette-outline" />}
          onPress={() => router.push("/dev/design-gallery")}
        />
      ) : null}

      {/* Which build/update this phone runs — docs/runbooks/releasing.md. Long-press: About this app. */}
      <Text
        variant="caption"
        color="tertiary"
        style={styles.versionLabel}
        onLongPress={showAppAbout}
        accessibilityHint="Long-press for the build number and update ID"
      >
        {getAppVersionLabel()}
      </Text>
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
  versionLabel: {
    textAlign: "center",
  },
});
