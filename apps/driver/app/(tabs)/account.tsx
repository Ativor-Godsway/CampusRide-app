import { useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Badge,
  Button,
  Card,
  Input,
  ListRow,
  Screen,
  Text,
  colors,
  confirmDeleteAccount,
  describeDeleteAccountError,
  describeDriverPhotoError,
  describeProfileSaveError,
  radii,
  spacing,
  updateDriverProfile,
  useAuth,
} from "@rida/mobile-shared";
import { useDriverActiveTrip } from "../../lib/activeTrip";
import { FakeLocationCard } from "../../components/dev/FakeLocationCard";
import { cloudinaryAvatar } from "@rida/shared";
import { useDriverPhotoUpload, type DriverPhotoResult, type PhotoSource } from "../../lib/useDriverPhotoUpload";

/** Account tab — view profile (name, vehicle, photo, approval) and edit it in place. */
export default function AccountTab() {
  const { user, refreshMe, signOut, deleteAccount } = useAuth();
  const driver = user?.driver;

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.name ?? "");
  const [carMake, setCarMake] = useState(driver?.carMake ?? "");
  const [carModel, setCarModel] = useState(driver?.carModel ?? "");
  const [carColor, setCarColor] = useState(driver?.carColor ?? "");
  const [plate, setPlate] = useState(driver?.plate ?? "");
  // Same pick-and-upload code as the onboarding photo step.
  const photo = useDriverPhotoUpload(driver?.photoUrl ?? null);
  const uploading = photo.isUploading;
  const photoUrl = photo.photoUrl;
  const [saving, setSaving] = useState(false);

  function startEdit() {
    // Reseed the form from the current auth state every time edit opens.
    setName(user?.name ?? "");
    setCarMake(driver?.carMake ?? "");
    setCarModel(driver?.carModel ?? "");
    setCarColor(driver?.carColor ?? "");
    setPlate(driver?.plate ?? "");
    photo.reset(driver?.photoUrl ?? null);
    setEditing(true);
  }

  function showPhotoResult(result: DriverPhotoResult) {
    if (!result || !("error" in result)) return;
    const { title, message } = describeDriverPhotoError(result.error);
    const retryable = result.error.kind !== "permission_denied";
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      ...(retryable ? [{ text: "Try again", onPress: () => void photo.retry().then(showPhotoResult) }] : []),
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
    if (!name.trim() || !carMake.trim() || !carModel.trim() || !carColor.trim() || !plate.trim()) {
      Alert.alert("Required", "Name and all vehicle fields are required.");
      return;
    }
    setSaving(true);
    try {
      await updateDriverProfile({
        name: name.trim(),
        carMake: carMake.trim(),
        carModel: carModel.trim(),
        carColor: carColor.trim(),
        plate: plate.trim().toUpperCase(),
        ...(photoUrl ? { photoUrl } : {}),
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

  // Permanent account closure. The server refuses with 409 while a ride is
  // still in flight, which describeDeleteAccountError surfaces verbatim.
  const startDeleteAccount = () =>
    confirmDeleteAccount({
      deleteAccount,
      onError: (error) => Alert.alert("Couldn't delete account", describeDeleteAccountError(error)),
    });

  const initial = user?.name?.charAt(0).toUpperCase() ?? "?";
  const { state: photoState } = photo;
  const editPreview =
    photoState.status === "uploading"
      ? photoState.localUri
      : photoState.status === "done"
        ? photoState.url
        : driver?.photoUrl ?? null;
  const shownPhoto = editing ? editPreview : driver?.photoUrl ?? null;
  const uploadPercent =
    photoState.status === "uploading" && photoState.progress !== null
      ? Math.round(photoState.progress * 100)
      : null;

  return (
    <Screen scroll style={styles.content}>
      <View style={styles.header}>
        <Pressable
          onPress={editing ? handlePickPhoto : undefined}
          disabled={!editing || uploading}
          style={styles.avatarWrap}
          accessibilityRole={editing ? "button" : undefined}
          accessibilityLabel={editing ? "Change profile photo" : undefined}
        >
          {shownPhoto ? (
            <Image source={{ uri: cloudinaryAvatar(shownPhoto, 60) }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatar}>
              <Text variant="h2" color="inverse">
                {initial}
              </Text>
            </View>
          )}
          {editing && (
            <View style={styles.avatarBadge}>
              {uploading ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <Ionicons name="camera" size={14} color={colors.white} />
              )}
            </View>
          )}
        </Pressable>

        <View style={styles.profileInfo}>
          {editing ? (
            <Input label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
          ) : (
            <>
              <Text variant="h2">{user?.name ?? "Driver"}</Text>
              <Text variant="bodySmall" color="muted">
                {user?.phone}
              </Text>
            </>
          )}
        </View>
      </View>

      {editing && (
        <Text variant="caption" color="muted" style={styles.photoHint} accessibilityLiveRegion="polite">
          {uploading
            ? uploadPercent === null
              ? "Preparing your photo upload…"
              : `Uploading your photo… ${uploadPercent}%`
            : photoState.status === "done" && photoState.localUri
              ? "New photo uploaded — tap Save to keep it."
              : "Tap your photo to change it."}
        </Text>
      )}

      {!editing && (
        <Badge
          label={driver?.isApproved ? "Approved" : "Pending approval"}
          variant={driver?.isApproved ? "success" : "warning"}
          style={styles.approvalBadge}
        />
      )}

      <Text variant="label" color="muted" style={styles.sectionLabel}>
        CAR DETAILS
      </Text>

      {editing ? (
        <Card style={styles.editCard}>
          <Input label="Make" value={carMake} onChangeText={setCarMake} autoCapitalize="words" />
          <Input label="Model" value={carModel} onChangeText={setCarModel} autoCapitalize="words" />
          <Input label="Color" value={carColor} onChangeText={setCarColor} autoCapitalize="words" />
          <Input
            label="Plate"
            value={plate}
            onChangeText={setPlate}
            autoCapitalize="characters"
          />
        </Card>
      ) : (
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
      )}

      {editing ? (
        <View style={styles.editActions}>
          <View style={styles.editActionItem}>
            <Button
              label="Cancel"
              variant="secondary"
              onPress={() => {
                photo.reset(driver?.photoUrl ?? null);
                setEditing(false);
              }}
              disabled={saving || uploading}
            />
          </View>
          <View style={styles.editActionItem}>
            <Button
              label="Save"
              onPress={() => void handleSave()}
              loading={saving}
              disabled={uploading}
            />
          </View>
        </View>
      ) : (
        <View style={styles.editButton}>
          <Button label="Edit profile" variant="secondary" onPress={startEdit} />
        </View>
      )}

      {!editing && <FakeLocationCard />}

      {!editing && (
        <Card style={styles.logoutCard}>
          <ListRow
            title="Log out"
            leading={
              <ListRow.Icon name="log-out-outline" color={colors.error} background={colors.errorSurface} />
            }
            onPress={confirmLogout}
            showChevron={false}
          />
          <View style={styles.divider} />
          <ListRow
            title="Delete account"
            leading={
              <ListRow.Icon name="trash-outline" color={colors.error} background={colors.errorSurface} />
            }
            onPress={startDeleteAccount}
            showChevron={false}
          />
        </Card>
      )}
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
  avatarWrap: {
    width: 60,
    height: 60,
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
  avatarBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: radii.full,
    backgroundColor: colors.primary[600],
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.white,
  },
  profileInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  photoHint: {
    marginTop: -spacing.md,
    marginBottom: spacing.xl,
  },
  approvalBadge: {
    alignSelf: "flex-start",
    marginBottom: spacing.xl,
  },
  sectionLabel: {
    marginBottom: spacing.md,
  },
  editCard: {
    gap: spacing.lg,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  editActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  editActionItem: {
    flex: 1,
  },
  editButton: {
    marginTop: spacing.xl,
  },
  logoutCard: {
    marginTop: spacing.xl,
  },
});
