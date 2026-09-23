import { useState } from "react";
import { useRouter } from "expo-router";
import { Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
 * Safety settings — the rider's single emergency contact.
 *
 * This is what the SOS button on an active ride uses: tapping SOS texts this
 * person the ride's current status and a link to follow it live. One contact
 * only, on purpose — a list implies priority ordering and a management UI,
 * and one reliable contact beats three half-configured ones.
 */
export default function SafetyScreen() {
  const router = useRouter();
  const { user, refreshMe } = useAuth();

  const [contactName, setContactName] = useState(user?.emergencyContactName ?? "");
  const [contactPhone, setContactPhone] = useState(user?.emergencyContactPhone ?? "");
  const [saving, setSaving] = useState(false);

  const hasExisting = Boolean(user?.emergencyContactName && user?.emergencyContactPhone);
  const name = contactName.trim();
  const phone = contactPhone.trim();

  async function handleSave() {
    if (!name || !phone) {
      Alert.alert(
        "Both fields needed",
        "We need a name and a number — the name tells them who's calling, the number is where we send the alert.",
      );
      return;
    }

    setSaving(true);
    try {
      await updateProfile({ emergencyContactName: name, emergencyContactPhone: phone });
      await refreshMe();
      router.back();
    } catch (error) {
      const message =
        (error as { response?: { data?: { error?: string } } }).response?.data?.error ??
        "Please check your connection and try again.";
      Alert.alert("Couldn't save", message);
    } finally {
      setSaving(false);
    }
  }

  function handleRemove() {
    Alert.alert(
      "Remove emergency contact?",
      "You won't be able to use the SOS button on a ride until you add one again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setSaving(true);
              try {
                await updateProfile({
                  emergencyContactName: null,
                  emergencyContactPhone: null,
                });
                await refreshMe();
                setContactName("");
                setContactPhone("");
              } catch {
                Alert.alert("Couldn't remove", "Please try again.");
              } finally {
                setSaving(false);
              }
            })();
          },
        },
      ],
    );
  }

  return (
    <Screen scroll style={styles.content}>
      <Text variant="h2">Safety</Text>

      <Card style={styles.explainer}>
        <View style={styles.explainerRow}>
          <Ionicons name="shield-checkmark" size={18} color={colors.primary[600]} />
          <Text variant="bodySmall" style={styles.explainerText}>
            During a ride you&apos;ll see an SOS button. Tapping it texts your emergency contact
            where you are, who your driver is, and a link to follow the trip live.
          </Text>
        </View>
      </Card>

      <Text variant="label" color="muted">
        EMERGENCY CONTACT
      </Text>

      <Card style={styles.card}>
        <Input
          label="Their name"
          placeholder="e.g. Mum"
          value={contactName}
          onChangeText={setContactName}
          autoCapitalize="words"
        />
        <Input
          label="Their phone number"
          placeholder="+233..."
          value={contactPhone}
          onChangeText={setContactPhone}
          keyboardType="phone-pad"
        />
        <Text variant="caption" color="muted">
          We never contact them unless you press SOS.
        </Text>
      </Card>

      <Button label="Save contact" onPress={() => void handleSave()} loading={saving} />

      {hasExisting && (
        <Button label="Remove contact" variant="secondary" onPress={handleRemove} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing["4xl"], gap: spacing.lg },
  explainer: { backgroundColor: colors.primary[50] },
  explainerRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  explainerText: { flex: 1 },
  card: { gap: spacing.lg },
});
