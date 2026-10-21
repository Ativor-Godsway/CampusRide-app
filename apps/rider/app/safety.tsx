import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  BackButton,
  Button,
  Illustration,
  Input,
  ListRow,
  Screen,
  Text,
  colors,
  spacing,
  updateProfile,
  useAuth,
} from "@rida/mobile-shared";

/** "How the Safety button works", one line each. */
const HOW_IT_WORKS: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
  { icon: "shield-checkmark-outline", text: "On a ride, tap Safety under your driver's details." },
  {
    icon: "megaphone-outline",
    text: "Alert my emergency contact texts them and CampusRide support where you are, with a link to follow the trip.",
  },
  { icon: "call-outline", text: "Call emergency services rings 112 and sends the same alert." },
];

/**
 * Safety settings — the rider's single emergency contact.
 *
 * This is who the SOS on an active ride texts (Safety → Alert my emergency
 * contact, or Call emergency services): the ride's current status and a link
 * to follow it live. One contact only, on purpose — a list implies priority
 * ordering and a management UI, and one reliable contact beats three
 * half-configured ones.
 */
export default function SafetyScreen() {
  const { user, refreshMe } = useAuth();
  const savedName = user?.emergencyContactName ?? "";
  const savedPhone = user?.emergencyContactPhone ?? "";
  const hasExisting = Boolean(savedName && savedPhone);

  const [editing, setEditing] = useState(false);
  const [contactName, setContactName] = useState(savedName);
  const [contactPhone, setContactPhone] = useState(savedPhone);
  const [saving, setSaving] = useState(false);

  const name = contactName.trim();
  const phone = contactPhone.trim();

  function startEditing() {
    setContactName(savedName);
    setContactPhone(savedPhone);
    setEditing(true);
  }

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
      setEditing(false);
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
      "If you ask for help on a ride, only CampusRide support will be texted until you add one again.",
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
                setEditing(false);
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
      <BackButton />
      <Illustration name="safetyShield" width={120} style={styles.hero} />
      <View style={styles.heading}>
        <Text variant="title1" accessibilityRole="header">
          Safety
        </Text>
        <Text variant="body" color="secondary">
          Someone we text if you ask for help on a ride. We never contact them otherwise.
        </Text>
      </View>

      <View style={styles.section}>
        <Text variant="eyebrow" color="secondary">
          Emergency contact
        </Text>
        {editing ? (
          <View style={styles.form}>
            <Input
              label="Their name"
              placeholder="e.g. Mum"
              value={contactName}
              onChangeText={setContactName}
              autoCapitalize="words"
              autoFocus
            />
            <Input
              label="Their phone number"
              placeholder="+233..."
              value={contactPhone}
              onChangeText={setContactPhone}
              keyboardType="phone-pad"
              doneAccessory
            />
            <Button label="Save contact" onPress={() => void handleSave()} loading={saving} />
            {hasExisting ? (
              <Button
                label="Remove contact"
                variant="danger"
                onPress={handleRemove}
                disabled={saving}
              />
            ) : null}
            <Button
              label="Cancel"
              variant="text"
              onPress={() => setEditing(false)}
              disabled={saving}
            />
          </View>
        ) : hasExisting ? (
          <ListRow
            title={savedName}
            subtitle={savedPhone}
            leading={<ListRow.Icon name="person-outline" tone="brand" />}
            onPress={startEditing}
            accessibilityLabel={`${savedName}, ${savedPhone}. Change your emergency contact`}
          />
        ) : (
          <View style={styles.form}>
            <Text variant="body" color="secondary">
              No emergency contact yet.
            </Text>
            <Button label="Add emergency contact" variant="secondary" onPress={startEditing} />
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Text variant="eyebrow" color="secondary">
          How the Safety button works
        </Text>
        {HOW_IT_WORKS.map((line) => (
          <View key={line.text} style={styles.line}>
            <Ionicons name={line.icon} size={20} color={colors.green700} />
            <Text variant="subhead" color="secondary" style={styles.lineText}>
              {line.text}
            </Text>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing[10], gap: spacing[6] },
  hero: { alignSelf: "center" },
  heading: { gap: spacing[2] },
  section: { gap: spacing[3] },
  form: { gap: spacing[3] },
  line: { flexDirection: "row", alignItems: "flex-start", gap: spacing[3] },
  lineText: { flex: 1 },
});
