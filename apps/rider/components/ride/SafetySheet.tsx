import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  BottomSheet,
  ListRow,
  Text,
  callPhone,
  colors,
  radii,
  raiseSos,
  sizes,
  spacing,
  useAuth,
} from "@rida/mobile-shared";
import { haptics } from "../../lib/haptics";

/** Ghana's national emergency number (police, fire, ambulance). */
const EMERGENCY_NUMBER = "112";

/**
 * Safety, opened from the round Safety button on a live ride
 * (docs/design-system.md, "Calm safety": SOS is never a big red button on
 * every ride). Opening it gives a warning buzz. Two separate ways to get
 * help, both after a confirm:
 *
 * - "Alert my emergency contact": the SOS alone (POST /rides/:id/sos). The
 *   server texts the rider's emergency contact AND CampusRide support where
 *   they are, who the driver is and a link to follow the trip. No call.
 *   Without a contact the row is "Add an emergency contact" instead.
 * - "Call emergency services (112)": the dialler opens, and the same SOS is
 *   sent at once.
 *
 * Either way the rider is told exactly who was reached.
 */
export function SafetySheet({
  visible,
  rideId,
  onDismiss,
  onShareTrip,
  showToast,
}: {
  visible: boolean;
  rideId: string;
  onDismiss: () => void;
  onShareTrip: () => void;
  /** The screen's toast (it sits above the sheet). */
  showToast: (message: string) => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const [sending, setSending] = useState<"alert" | "call" | null>(null);
  const contactName =
    user?.emergencyContactName && user.emergencyContactPhone ? user.emergencyContactName : null;
  const contactFirstName = contactName?.trim().split(/\s+/)[0] ?? null;

  useEffect(() => {
    if (visible) haptics.warning();
  }, [visible]);

  async function sendSos(via: "alert" | "call") {
    setSending(via);
    try {
      const result = await raiseSos(rideId);

      // Report exactly who was actually reached, rather than a
      // blanket "sent" — in an emergency the difference matters.
      const reached: string[] = [];
      if (result.smsDelivered && result.contactName) reached.push(result.contactName);
      if (result.supportNotified) reached.push("CampusRide support");

      if (reached.length > 0 && result.alreadyAlerted) {
        // A repeat press: the first one got through moments ago.
        Alert.alert(
          "SOS already sent",
          `${reached.join(" and ")} ${reached.length === 1 ? "was" : "were"} sent a link to follow your trip a moment ago. If you're in danger, call someone now.`,
        );
      } else if (result.smsDelivered && result.contactName) {
        // Their own person got it: say so briefly, and get out of the way.
        onDismiss();
        showToast(`We alerted ${result.contactName.trim().split(/\s+/)[0]}`);
      } else if (reached.length > 0) {
        const nudge = result.hasEmergencyContact
          ? ""
          : "\n\nAdd an emergency contact in Account → Safety so someone you know is alerted too.";
        Alert.alert(
          "SOS sent",
          `${reached.join(" and ")} ${reached.length === 1 ? "has" : "have"} been sent a link to follow your trip.${nudge}`,
        );
      } else {
        // Nothing got through — hand over the link so the rider can
        // still get help through some other channel.
        Alert.alert(
          "SOS raised, but we couldn't send a message",
          `Share this link with someone you trust, or call them directly:\n\n${result.trackingUrl}`,
        );
      }
    } catch {
      Alert.alert("Couldn't send SOS", "Please try again, or call someone directly.");
    } finally {
      setSending(null);
    }
  }

  function confirmAlert() {
    Alert.alert(
      `Alert ${contactFirstName}?`,
      `We'll text ${contactName} and CampusRide support where you are, who your driver is, and a link to follow this trip.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Send alert", style: "destructive", onPress: () => void sendSos("alert") },
      ],
    );
  }

  function confirmEmergency() {
    Alert.alert(
      "Call emergency services?",
      `We'll open your phone to call ${EMERGENCY_NUMBER}, and text ${contactName ?? "CampusRide support"}${contactName ? " and CampusRide support" : ""} where you are, who your driver is, and a link to follow this trip.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: `Call ${EMERGENCY_NUMBER}`,
          style: "destructive",
          onPress: () => {
            // The call first: it must never wait on the network.
            void callPhone(EMERGENCY_NUMBER, "emergency services");
            void sendSos("call");
          },
        },
      ],
    );
  }

  function openContacts() {
    onDismiss();
    router.push("/safety");
  }

  return (
    <BottomSheet modal visible={visible} onDismiss={onDismiss} accessibilityLabel="Safety">
      <View style={styles.content}>
        <Text variant="title2" accessibilityRole="header">
          Safety
        </Text>

        <View>
          <ListRow
            title="Share trip with a contact"
            subtitle="Your route and the car you're in"
            leading={<ListRow.Icon name="share-outline" />}
            onPress={onShareTrip}
          />
          {contactName ? (
            <>
              <ListRow
                divider
                title="Alert my emergency contact"
                subtitle={`Text ${contactFirstName} where you are`}
                leading={<ListRow.Icon name="megaphone-outline" />}
                trailing={
                  sending === "alert" ? <ActivityIndicator color={colors.ink2} /> : undefined
                }
                onPress={confirmAlert}
                disabled={sending !== null}
              />
              <ListRow
                divider
                title="Emergency contacts"
                subtitle={contactName}
                leading={<ListRow.Icon name="people-outline" />}
                onPress={openContacts}
              />
            </>
          ) : (
            <ListRow
              divider
              title="Add an emergency contact"
              subtitle="Someone we can text if you need help"
              leading={<ListRow.Icon name="person-add-outline" />}
              onPress={openContacts}
            />
          )}
        </View>

        <Pressable
          onPress={confirmEmergency}
          disabled={sending !== null}
          accessibilityRole="button"
          accessibilityLabel={`Call emergency services, ${EMERGENCY_NUMBER}`}
          accessibilityHint="Also texts your emergency contact and CampusRide support"
          accessibilityState={{ busy: sending === "call", disabled: sending !== null }}
          style={({ pressed }) => [styles.emergency, pressed && styles.emergencyPressed]}
        >
          {sending === "call" ? (
            <ActivityIndicator color={colors.red600} />
          ) : (
            <>
              <Ionicons name="call" size={20} color={colors.red600} />
              <Text variant="button" style={styles.emergencyLabel}>
                Call emergency services ({EMERGENCY_NUMBER})
              </Text>
            </>
          )}
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[4] },
  // Danger-tonal: red-50 fill, red-600 label, the full 56 height.
  emergency: {
    minHeight: sizes.controlLg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[2],
    borderRadius: radii.md,
    backgroundColor: colors.red50,
    paddingHorizontal: spacing[5],
  },
  emergencyPressed: { opacity: 0.85 },
  emergencyLabel: { color: colors.red600 },
});
