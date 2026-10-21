import { useState } from "react";
import { useRouter } from "expo-router";
import { Alert, StyleSheet } from "react-native";
import { formatGhanaPhone } from "@rida/shared";
import {
  BackButton,
  Button,
  Input,
  Screen,
  Text,
  spacing,
  updateProfile,
  useAuth,
  rateLimitText,
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

  // Null until the rider types: until then the field shows the account's
  // name, even if it loads after this screen opens.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? user?.name ?? "";
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
    } catch (err) {
      Alert.alert("Couldn't save", rateLimitText(err) ?? "Please check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen scroll style={styles.content}>
      <BackButton />
      <Text variant="title1" accessibilityRole="header">
        Profile
      </Text>

      <Input label="Name" value={name} onChangeText={setDraft} autoCapitalize="words" />
      {/* Locked: it is the sign-in. */}
      <Input
        label="Phone number"
        value={user?.phone ? formatGhanaPhone(user.phone) : ""}
        editable={false}
        helper="Your phone number is how you sign in, so it can't be changed here. Contact support to move your account to a new number."
      />

      <Button
        label="Save"
        onPress={() => void handleSave()}
        loading={saving}
        disabled={unchanged || trimmed.length === 0}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing[10], gap: spacing[5] },
});
