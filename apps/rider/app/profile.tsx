import { useState } from "react";
import { useRouter } from "expo-router";
import { Alert, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  Input,
  Screen,
  Text,
  colors,
  spacing,
  updateProfile,
  useAuth,
} from "@rida/mobile-shared";

/**
 * Rider profile edit — the counterpart to the driver app's profile form.
 *
 * Only the display name is editable. The phone number is shown but locked:
 * it is the login identity, so changing it needs a fresh OTP verification of
 * the new number, which is a separate flow and deliberately not built here.
 */
export default function EditProfileScreen() {
  const router = useRouter();
  const { user, refreshMe } = useAuth();

  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);

  const trimmed = name.trim();
  const unchanged = trimmed === (user?.name ?? "");

  async function handleSave() {
    if (!trimmed) {
      Alert.alert("Name required", "Please enter your name.");
      return;
    }

    setSaving(true);
    try {
      await updateProfile({ name: trimmed });
      // Refresh so every screen showing the name (account header, ride
      // screens) picks up the change without a restart.
      await refreshMe();
      router.back();
    } catch {
      Alert.alert("Couldn't save", "Please check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen scroll style={styles.content}>
      <Text variant="h2">Edit profile</Text>

      <Card style={styles.card}>
        <Input label="Name" value={name} onChangeText={setName} autoCapitalize="words" />

        <View style={styles.lockedField}>
          <Text variant="label" color="muted">
            PHONE NUMBER
          </Text>
          <Text variant="bodyMedium">{user?.phone}</Text>
          <Text variant="caption" color="muted">
            Your phone number is how you sign in, so it can&apos;t be changed here. Contact
            support if you need to move your account to a new number.
          </Text>
        </View>
      </Card>

      <Button
        label="Save changes"
        onPress={() => void handleSave()}
        loading={saving}
        disabled={unchanged || trimmed.length === 0}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing["4xl"], gap: spacing.lg },
  card: { gap: spacing.lg },
  lockedField: {
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.lg,
  },
});
