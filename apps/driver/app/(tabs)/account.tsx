import { useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
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
  isCloudinaryConfigured,
  radii,
  spacing,
  updateDriverProfile,
  uploadImageToCloudinary,
  useAuth,
} from "@rida/mobile-shared";

/** Account tab — view profile (name, vehicle, photo, approval) and edit it in place. */
export default function AccountTab() {
  const { user, refreshMe, signOut } = useAuth();
  const driver = user?.driver;

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.name ?? "");
  const [carMake, setCarMake] = useState(driver?.carMake ?? "");
  const [carModel, setCarModel] = useState(driver?.carModel ?? "");
  const [carColor, setCarColor] = useState(driver?.carColor ?? "");
  const [plate, setPlate] = useState(driver?.plate ?? "");
  const [photoUrl, setPhotoUrl] = useState<string | null>(driver?.photoUrl ?? null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    // Reseed the form from the current auth state every time edit opens.
    setName(user?.name ?? "");
    setCarMake(driver?.carMake ?? "");
    setCarModel(driver?.carModel ?? "");
    setCarColor(driver?.carColor ?? "");
    setPlate(driver?.plate ?? "");
    setPhotoUrl(driver?.photoUrl ?? null);
    setEditing(true);
  }

  async function handlePickPhoto() {
    if (!isCloudinaryConfigured()) {
      Alert.alert("Photo upload unavailable", "Image hosting isn't configured yet.");
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Allow photo access to change your picture.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets?.[0]) return;

    setUploading(true);
    try {
      const url = await uploadImageToCloudinary(result.assets[0].uri);
      setPhotoUrl(url);
    } catch {
      Alert.alert("Upload failed", "Couldn't upload that photo. Please try again.");
    } finally {
      setUploading(false);
    }
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
    } catch {
      Alert.alert("Couldn't save", "Please check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const confirmLogout = () => {
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void signOut() },
    ]);
  };

  const initial = user?.name?.charAt(0).toUpperCase() ?? "?";
  const shownPhoto = editing ? photoUrl : driver?.photoUrl ?? null;

  return (
    <Screen scroll style={styles.content}>
      <View style={styles.header}>
        <Pressable
          onPress={editing ? () => void handlePickPhoto() : undefined}
          disabled={!editing || uploading}
          style={styles.avatarWrap}
          accessibilityRole={editing ? "button" : undefined}
          accessibilityLabel={editing ? "Change profile photo" : undefined}
        >
          {shownPhoto ? (
            <Image source={{ uri: shownPhoto }} style={styles.avatarImage} />
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
              onPress={() => setEditing(false)}
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
