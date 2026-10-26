import { useState } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Alert, Image, StyleSheet, View } from "react-native";
import {
  PRIVACY_URL,
  TERMS_URL,
  WEBSITE_URL,
  cloudinaryAvatar,
  formatGhanaPhone,
  initialsOf,
} from "@rida/shared";
import {
  Button,
  Card,
  Input,
  ListRow,
  Screen,
  StatusChip,
  Text,
  colors,
  describeDriverPhotoError,
  describeProfileSaveError,
  getAppVersionLabel,
  openLegalPage,
  radii,
  showAppAbout,
  spacing,
  updateDriverProfile,
  useAuth,
} from "@rida/mobile-shared";
import { useDriverActiveTrip } from "../../lib/activeTrip";
import { FakeLocationCard } from "../../components/dev/FakeLocationCard";
import { CarDetailsForm, type CarDetails } from "../../components/CarDetailsForm";
import {
  useDriverPhotoUpload,
  type DriverPhotoResult,
  type PhotoSource,
} from "../../lib/useDriverPhotoUpload";

const SUPPORT_URL = `${WEBSITE_URL}/support`;

/**
 * Account tab: who's driving (photo, name, number, approval), their car as
 * riders will look for it with Edit, then grouped rows — notifications,
 * help, the legal pages and licences — and leaving (log out, delete
 * account). The version at the bottom; the dev-only fake location under it.
 */
export default function AccountTab() {
  const router = useRouter();
  const { user, refreshMe, signOut } = useAuth();
  const driver = user?.driver;

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.name ?? "");
  const [car, setCar] = useState<CarDetails>({
    carMake: driver?.carMake ?? "",
    carModel: driver?.carModel ?? "",
    carColor: driver?.carColor ?? "",
    plate: driver?.plate ?? "",
  });
  // Same pick-and-upload code as the onboarding photo step.
  const photo = useDriverPhotoUpload(driver?.photoUrl ?? null);
  const uploading = photo.isUploading;
  const [saving, setSaving] = useState(false);

  function startEdit() {
    // Reseed the form from the current account every time edit opens.
    setName(user?.name ?? "");
    setCar({
      carMake: driver?.carMake ?? "",
      carModel: driver?.carModel ?? "",
      carColor: driver?.carColor ?? "",
      plate: driver?.plate ?? "",
    });
    photo.reset(driver?.photoUrl ?? null);
    setEditing(true);
  }

  function showPhotoResult(result: DriverPhotoResult) {
    if (!result || !("error" in result)) return;
    const { title, message } = describeDriverPhotoError(result.error);
    const retryable = result.error.kind !== "permission_denied";
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      ...(retryable
        ? [{ text: "Try again", onPress: () => void photo.retry().then(showPhotoResult) }]
        : []),
    ]);
  }

  function handlePickPhoto() {
    const pickFrom = (source: PhotoSource) => void photo.pick(source).then(showPhotoResult);
    Alert.alert("Change profile photo", undefined, [
      { text: "Take a selfie", onPress: () => pickFrom("camera") },
      { text: "Choose from gallery", onPress: () => pickFrom("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function handleSave() {
    const fields = [name, car.carMake, car.carModel, car.carColor, car.plate];
    if (fields.some((f) => !f.trim())) {
      Alert.alert("Required", "Your name and all the car details are needed.");
      return;
    }
    setSaving(true);
    try {
      await updateDriverProfile({
        name: name.trim(),
        carMake: car.carMake.trim(),
        carModel: car.carModel.trim(),
        carColor: car.carColor.trim(),
        plate: car.plate.trim().toUpperCase(),
        ...(photo.photoUrl ? { photoUrl: photo.photoUrl } : {}),
      });
      await refreshMe();
      setEditing(false);
    } catch (error) {
      const { title, message } = describeProfileSaveError(error);
      Alert.alert(title, message);
    } finally {
      setSaving(false);
    }
  }

  const { data: activeTrip } = useDriverActiveTrip();
  const confirmLogout = () => {
    // Logging out never ends a trip; say so, so it isn't done by mistake.
    const message = activeTrip
      ? "You're on a trip. Logging out won't end it — your rider is still expecting you. Log back in to carry on."
      : "Are you sure you want to log out?";
    Alert.alert("Log out", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void signOut() },
    ]);
  };

  const { state: photoState } = photo;
  const editPreview =
    photoState.status === "uploading"
      ? photoState.localUri
      : photoState.status === "done"
        ? photoState.url
        : (driver?.photoUrl ?? null);
  const shownPhoto = editing ? editPreview : (driver?.photoUrl ?? null);
  const carLine = [driver?.carColor, driver?.carMake, driver?.carModel].filter(Boolean).join(" ");

  if (editing) {
    return (
      <Screen scroll edges={["top"]} style={styles.content}>
        <Text variant="title1" accessibilityRole="header" style={styles.title}>
          Edit profile
        </Text>
        <View style={styles.editPhoto}>
          <Avatar uri={shownPhoto} name={name} size={88} busy={uploading} />
          <Button
            label="Change photo"
            variant="text"
            icon="camera-outline"
            onPress={handlePickPhoto}
            disabled={uploading}
          />
        </View>
        <Input label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
        <CarDetailsForm value={car} onChange={setCar} />
        <View style={styles.editActions}>
          <Button
            label="Save"
            onPress={() => void handleSave()}
            loading={saving}
            disabled={uploading}
          />
          <Button
            label="Cancel"
            variant="text"
            onPress={() => {
              photo.reset(driver?.photoUrl ?? null);
              setEditing(false);
            }}
            disabled={saving || uploading}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll edges={["top"]} style={styles.content}>
      <View style={styles.header}>
        <Avatar uri={shownPhoto} name={user?.name ?? ""} size={64} />
        <View style={styles.profileInfo}>
          <Text variant="title2" numberOfLines={1}>
            {user?.name ?? "Driver"}
          </Text>
          <Text variant="subhead" color="secondary">
            {user?.phone ? formatGhanaPhone(user.phone) : null}
          </Text>
          <StatusChip
            label={driver?.isApproved ? "Approved" : "Pending approval"}
            tone={driver?.isApproved ? "brand" : "warn"}
            icon={driver?.isApproved ? "checkmark-circle" : "time-outline"}
            style={styles.approval}
          />
        </View>
      </View>

      <Card variant="filled" style={styles.carCard}>
        <View style={styles.carHeader}>
          <Text variant="title3" accessibilityRole="header">
            Your car
          </Text>
          <Button label="Edit" variant="text" size="pill" onPress={startEdit} />
        </View>
        <View style={styles.carRow}>
          <Text variant="body" style={styles.carText} numberOfLines={2}>
            {carLine || "Not set yet"}
          </Text>
          {driver?.plate ? (
            <View style={styles.plateFrame}>
              <Text variant="plate" numberOfLines={1}>
                {driver.plate}
              </Text>
            </View>
          ) : null}
        </View>
      </Card>

      <View>
        <ListRow
          title="Notifications"
          subtitle="Ride requests when the app is closed"
          leading={<ListRow.Icon name="notifications-outline" />}
          onPress={() => router.push("/notifications")}
        />
        <ListRow
          divider
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
        <ListRow
          divider
          title="Open-source licenses"
          leading={<ListRow.Icon name="code-slash-outline" />}
          onPress={() => router.push("/licenses")}
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

      {/* Dev builds only (it renders nothing in a release build). */}
      <FakeLocationCard />
    </Screen>
  );
}

/** The driver's photo, or their initial; a spinner over it while a new one uploads. */
function Avatar({
  uri,
  name,
  size,
  busy = false,
}: {
  uri: string | null;
  name: string;
  size: number;
  busy?: boolean;
}) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={round}>
      {uri ? (
        <Image
          source={{ uri: cloudinaryAvatar(uri, size) }}
          style={round}
          accessibilityLabel="Your photo"
        />
      ) : (
        <View style={[round, styles.initial]}>
          <Text variant="title2" color="brand">
            {initialsOf(name, 1) || "?"}
          </Text>
        </View>
      )}
      {busy ? (
        <View style={[StyleSheet.absoluteFill, styles.busy, round]}>
          <ActivityIndicator color={colors.onBrand} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[6], paddingBottom: spacing[10] },
  title: { marginTop: spacing[2] },
  header: { flexDirection: "row", alignItems: "center", gap: spacing[4], marginTop: spacing[2] },
  profileInfo: { flex: 1, gap: 2 },
  approval: { alignSelf: "flex-start", marginTop: spacing[1] },
  initial: { backgroundColor: colors.green50, alignItems: "center", justifyContent: "center" },
  busy: { backgroundColor: colors.scrim, alignItems: "center", justifyContent: "center" },
  carCard: { gap: spacing[3] },
  carHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  carRow: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  carText: { flex: 1 },
  // The plate frame: white, 1.5 ink border, radius-sm (docs/design-system.md).
  plateFrame: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  editPhoto: { alignItems: "center", gap: spacing[2] },
  editActions: { gap: spacing[2] },
  versionLabel: { textAlign: "center" },
});
